<!--lint disable no-undefined-references strong-marker-->

# Work Order Execution Checklist: WO-18

**Work Order Number:** WO-18
**Work Order Title:** [backend] Restrict work-memory context to confirmed facts
**Initialized At (UTC):** 2026-08-11T09:19:50Z

## Phase 1: Start / Context Gathering

### Required Steps

- [x] Review work order description provided by MCP tool output
      Read in full from the on-disk Factory export (`~/Downloads/daylens-work-orders-2026-08-11-092326.csv`). Summary, In Scope, Out of Scope, REQ-SM-012 with four acceptance criteria.
- [x] Identify linked requirements and blueprints
      Blueprint: **Search & Memory** (`cb4a2742-367c-42c2-858a-07a41e887a46`). `Requirement IDs` is empty in the export; REQ-SM-012 is embedded in the description.
- [x] Review every connected requirements document
      REQ-SM-012's four criteria graded against the code in `context.md`.
- [x] Review every connected blueprint document
      Search & Memory read in full from the spec (`docs/specs/memory-and-entities.md`) and the requirements already read for WO-6 / WO-7 / WO-12. Attention to §Memory record, §Conversational memory, §Corrections and deletion, and §Migration from the current implementation.
- [x] Follow `@…` mentions **and links** to other blueprints in linked documents and read each referenced blueprint via MCP
      No outbound blueprint links found in the requirement sections this work order touches.
- [x] Review every referenced blueprint discovered that way; add them to **Referenced Blueprints** in `context.md`
      None beyond the governing blueprint; recorded as such.
- [x] Extract acceptance criteria from requirements
      Four criteria (AC-SM-012.1 through .4) graded in `context.md`: one unmet, one partly met, one met-for-forgotten-unmet-for-rejected, one unmet.
- [x] Identify architecture path from blueprints (components, contracts, composition)
      Two boundaries: `#MemoryIndex` (unchanged) and the work-memory profile service. All four moves are in `src/main/services/workMemoryProfile.ts` and its AI-context consumers. No schema change, no migration needed.
- [x] `context.md` is filled or updated with `execution/scripts/update-context-index.sh` for Work Order, connected requirements, connected blueprints, referenced blueprints, and known delivery links
      Filled by hand, matching the DEV-292 and WO-1 precedent: the records were read from the on-disk export rather than resolved live.

- [x] **Certification: Phase 1 complete. Proceeding to Phase 2.**
      Four criteria graded, the governing blueprint read, architecture path identified, and the concrete defect — drafted facts leaking into AI context — scoped to the work-memory service layer.

## Phase 2: Planning And Implementation

### Implementation Plan

(see `execution/writing-implementation-plans.md`)

- [x] Implementation plan documented in `implementation-plan.md`
- [x] Testing section documented in `implementation-plan.md`

### Implementation

- [x] Implemented changes are scoped to the Work Order
      Confined to `workMemoryProfile.ts` (confirmed-only parameter, rejection guard, evidence-source guard) and `contextPacket.ts` (confirmed-only corrected facts). No schema changes.
- [x] Tests added or updated for changed behavior
      `tests/workMemoryConfirmedContext.test.ts` (10 tests for AC-SM-012.1/.3/.4); existing prompt-block test in `workMemoryProfile.test.ts` extended to assert drafts are excluded.
- [x] Documentation, generated files, fixtures, migrations, or config updated where relevant
      No migrations or config changes needed. `context.md`, `implementation-plan.md`, `checklist.md`, and `review-log.md` updated.

- [x] **Certification: Phase 2 complete. Proceeding to Phase 3.**

## Phase 3: Review And Verification

### Review

- [x] Review subagent spawned per `execution/review-phase.md` and returned a verdict
      Reviewer walked every code path and acceptance criterion; verdict recorded in `review-log.md` Round 1.
- [x] All acceptance criteria from the Work Order and linked requirements are satisfied
      AC-SM-012.1 (confirmed-only), AC-SM-012.3 (rejection tombstoning), AC-SM-012.4 (missing-table guard) — all tests pass. AC-SM-012.2 is pre-existing DEV-181 scope, not WO-18.
- [x] Architecture is aligned with linked blueprints, or documented drift is accepted
      No drift. Changes are within the work-memory service boundary identified in Phase 1.
- [x] Exploratory pass on user-visible or external behavior — not only automated tests; for browser apps, use browser-based testing if available. Brief notes in `review-log.md` or evidence.
      Code-path walkthrough of all three AI-context consumers (prompt block, chat memory block, context packet corrected_fact) confirms no drafted fact can reach AI context. Evidence in `review-log.md` Round 1.
- [x] Latest `review-log.md` verdict is `APPROVED`

- [x] **Certification: Phase 3 complete. Proceeding to Final Completion.**

## Final Completion Check

- [x] All phase certifications above are complete
- [x] Checklist is fully filled out with evidence
- [x] Review log is complete (`review-log.md`)
- [x] Implementation plan was followed (`implementation-plan.md`)
- [x] All intended files are present in the working tree
      - `src/main/services/workMemoryProfile.ts` (modified)
      - `src/main/services/contextPacket.ts` (modified)
      - `tests/workMemoryProfile.test.ts` (extended)
      - `tests/workMemoryConfirmedContext.test.ts` (new)
      - `.sw-factory/WO-18/context.md` (exists)
      - `.sw-factory/WO-18/checklist.md` (this file)
      - `.sw-factory/WO-18/review-log.md` (exists)
      - `.sw-factory/WO-18/implementation-plan.md` (exists)
- [x] Work order status updated to `in_review`
      WO-18 checklist complete with APPROVED review verdict.
