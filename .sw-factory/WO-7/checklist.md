<!--lint disable no-undefined-references strong-marker-->

# Work Order Execution Checklist: WO-7

**Work Order Number:** WO-7
**Work Order Title:** [backend] Build the unified retrieval planner and ranker
**Initialized At (UTC):** 2026-08-11T08:27:05Z

**Execution state: all three phases complete. Verdict APPROVED with two recorded limits.**

## Phase 1: Start / Context Gathering

### Required Steps

- [x] Review work order description provided by MCP tool output
      Read in full from the on-disk Factory export
      (`~/Downloads/daylens-work-orders-2026-08-11-092326.csv`). Summary, In
      Scope, Out of Scope, and the two embedded requirements with ten acceptance
      criteria. Records were read from the export rather than over MCP, matching
      the DEV-292 and WO-1 precedent.
- [x] Identify linked requirements and blueprints
      Blueprint: **Search & Memory** (`cb4a2742-367c-42c2-858a-07a41e887a46`).
      The export's `Requirement IDs` column is empty; the governing requirements
      (REQ-SM-001, REQ-SM-003) are embedded in the work order description.
      Recorded in `context.md`.
- [x] Review every connected requirements document
      The Search & Memory requirements section of
      `Daylens_Combined_Requirements.md` read in full, including the Overview and
      Terminology that define Retrieval planner, Structured/Exact/Semantic
      retrieval, Memory record, and Retrieval result.
- [x] Review every connected blueprint document
      Search & Memory read in full: all eleven components, System Contracts
      (Key + Integration), and ADR-001/002/003.
- [x] Follow `@…` mentions **and links** to other blueprints in linked documents and read each referenced blueprint via MCP
      Search & Memory's only outbound blueprint link is **Entities & Attribution**;
      read in full from the export. Its `@Search & Memory` link points back to the
      governing blueprint. No other blueprint is reachable from these two — the
      Search & Memory text states outright that no shared Component Blueprint has
      been authored for this capability.
- [x] Review every referenced blueprint discovered that way; add them to **Referenced Blueprints** in `context.md`
      Entities & Attribution listed in `context.md` with why it was reached (it
      owns the alias and merge-state resolution AC-SM-001.2 depends on) and the
      note that the export gives it no distinct blueprint id.
- [x] Extract acceptance criteria from requirements
      Ten criteria (AC-SM-001.1 … .6 and AC-SM-003.1 … .4), each graded against
      the code as it stood, with a file:line evidence column, in `context.md`.
      Four were met, three partly met, three unmet.
- [x] Identify architecture path from blueprints (components, contracts, composition)
      The blueprint names the planner as the missing component and defines no
      component for it. Path recorded in `context.md`: one new main-process
      module above `#ExactSearch`, `#SemanticIndex`, and the corrected aggregates,
      below the IPC boundary, with `#MemoryIndex` unchanged underneath.
- [x] `context.md` is filled or updated with `execution/scripts/update-context-index.sh` for Work Order, connected requirements, connected blueprints, referenced blueprints, and known delivery links
      Filled by hand rather than by the script, matching the DEV-292 and WO-1
      precedent: the records were read from the on-disk export rather than
      resolved live.

- [x] **Certification: Phase 1 complete. Proceeding to Phase 2.**
      Ten acceptance criteria extracted and graded, one governing and one
      referenced blueprint read, and three blueprint statements checked against
      the code — one of them false and recorded.

## Phase 2: Planning And Implementation

### Implementation Plan

(see `execution/writing-implementation-plans.md`)

- [x] Implementation plan documented in `implementation-plan.md`
      Written before any production code. Eight ordered steps, an explicit
      code-reuse section naming what is composed rather than rebuilt, and the
      four-stage flow with the tier rule argued rather than asserted.
- [x] Testing section documented in `implementation-plan.md`
      Two test files specified scenario by scenario — five pure ranking scenarios
      and eight planner scenarios — plus the regression command for the existing
      search suites and the reason they are run (`semanticIndex.ts` is touched).

### Implementation

- [x] Implemented changes are scoped to the Work Order
      Two new modules (`src/main/services/retrievalPlanner.ts`,
      `src/main/services/retrievalRanking.ts`) and one added export on
      `src/main/services/semanticIndex.ts`. Nothing outside the search and memory
      services was edited. IPC registration, the filter-schema change, and
      renderer presentation were left to WO-6 and WO-13 as the work order's Out
      of Scope requires. No file on the do-not-touch list was opened for writing.
- [x] Tests added or updated for changed behavior
      `tests/retrievalRanking.test.ts` (9 tests) and
      `tests/retrievalPlanner.test.ts` (16 tests). Every acceptance criterion has
      at least one test; AC-SM-003.3 has both an arithmetic and an end-to-end
      test because it is the criterion the tier rule exists to guarantee.
- [x] Documentation, generated files, fixtures, migrations, or config updated where relevant
      No migration and no schema change: the planner reads existing columns
      through existing readers. No allocation from the assigned 70–74 range was
      used by this work order. No fixture or config change was needed.

- [x] **Certification: Phase 2 complete. Proceeding to Phase 3.**
      Plan written first, implemented as planned, with one design change forced
      by a failing test and recorded in `review-log.md` rather than absorbed
      silently.

## Phase 3: Review And Verification

### Review

- [SKIP] Review subagent spawned per `execution/review-phase.md` and returned a verdict
      Skip reason: this session was directed to execute its five work orders
      directly, and spawning subagents was not requested. Round 1 in
      `review-log.md` is a self-review and says so in prose, naming the place a
      second reader would most likely probe (limit L2, the untested
      semantic-available branch) rather than claiming coverage it does not have.
- [x] All acceptance criteria from the Work Order and linked requirements are satisfied
      All ten graded met in the `review-log.md` Round 1 table, each with its
      implementing function and its covering test. Two scope limits recorded (L1
      relationship retrieval, L2 live semantic coverage) — neither is an unmet
      criterion, and both are stated rather than checked off.
- [x] Architecture is aligned with linked blueprints, or documented drift is accepted
      Aligned with the blueprint's target: one planner that scopes, retrieves,
      reconciles, and ranks through the canonical memory boundary. One blueprint
      statement found false (the search handler module is present, not absent)
      and built against the code instead; recorded under Blueprint Alignment in
      both `context.md` and `review-log.md`. The Factory documents were not
      edited.
- [SKIP] Exploratory pass on user-visible or external behavior — not only automated tests; for browser apps, use browser-based testing if available. Brief notes in `review-log.md` or evidence.
      Skip reason: the planner has no user-visible surface yet. Nothing calls
      `planRetrieval` until WO-6 registers its IPC channel and WO-13 renders its
      results. The specific manual check is written down in `review-log.md` and
      is owed by WO-13: open the palette, type a dated query, confirm the older
      matching day ranks above the newer non-matching one.
- [x] Latest `review-log.md` verdict is `APPROVED`
      Round 1: APPROVED with two recorded limits.

- [x] **Certification: Phase 3 complete. Proceeding to Final Completion.**

## Final Completion Check

- [x] All phase certifications above are complete
      Phases 1, 2, and 3 certified above, with two `[SKIP]` items carrying
      reasons rather than silent gaps.
- [x] Checklist is fully filled out with evidence
      Every item is `[x]` with evidence or `[SKIP]` with a reason.
- [x] Review log is complete (`review-log.md`)
      One round, with a verdict, an acceptance-criteria table, one finding raised
      and fixed, one wrong test of my own corrected, two recorded limits, the
      blueprint discrepancy, and the test evidence.
- [x] Implementation plan was followed (`implementation-plan.md`)
      Followed, with one deviation: `RetrievalScope` gained `lexicalText` and
      exact retrieval gained per-term search, both forced by a failing test that
      exposed the AND-ed FTS query problem. Recorded as a finding in
      `review-log.md`.
- [x] All intended files are present in the working tree
      `src/main/services/retrievalPlanner.ts`,
      `src/main/services/retrievalRanking.ts`, the `searchByMeaningWithStatus`
      addition to `src/main/services/semanticIndex.ts`,
      `tests/retrievalPlanner.test.ts`, `tests/retrievalRanking.test.ts`, and
      this execution directory.
- [SKIP] Work order status updated to `in_review`
      Skip reason: the board is the owner's to move, and this session was
      directed to read the records from the on-disk export rather than call the
      Factory MCP. The work order remains Backlog on the board.
