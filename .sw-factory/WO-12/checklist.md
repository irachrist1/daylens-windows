<!--lint disable no-undefined-references strong-marker-->

# Work Order Execution Checklist: WO-12

**Work Order Number:** WO-12
**Work Order Title:** [data] Make canonical memory records the only exact-search boundary
**Initialized At (UTC):** 2026-08-11T10:05:00Z

**Execution state: all three phases complete. Verdict APPROVED with two recorded limits.**

## Phase 1: Start / Context Gathering

### Required Steps

- [x] Review work order description provided by MCP tool output
      Read in full from the on-disk Factory export: Summary, In Scope, Out of
      Scope, and the two embedded requirements with five acceptance criteria.
- [x] Identify linked requirements and blueprints
      Blueprint: **Search & Memory** (`cb4a2742-367c-42c2-858a-07a41e887a46`).
      REQ-SM-005 and REQ-SM-006 embedded in the description; `Requirement IDs`
      is empty in the export.
- [x] Review every connected requirements document
      Both requirements graded criterion by criterion in `context.md` against
      the code, with file evidence.
- [x] Review every connected blueprint document
      Search & Memory re-read for this work order, with attention to
      #MemoryIndex's responsibilities, ADR-001, and the Key Contract that
      `memory_records` is the canonical retrievable representation.
- [x] Follow `@…` mentions **and links** to other blueprints in linked documents and read each referenced blueprint via MCP
      Entities & Attribution, the only outbound blueprint link. Relevant because
      page and artifact records are entity-named where an entity exists.
- [x] Review every referenced blueprint discovered that way; add them to **Referenced Blueprints** in `context.md`
      Listed with why it was reached.
- [x] Extract acceptance criteria from requirements
      Five criteria graded in `context.md`: one partly met, one met, one met for
      sessions only, one unmet with a reader carrying no filter at all, one met
      for sessions and absent elsewhere.
- [x] Identify architecture path from blueprints (components, contracts, composition)
      `#MemoryIndex` as the sole exact-retrieval data boundary; three moves
      recorded in `context.md`, including which reader is deliberately excluded.
- [x] `context.md` is filled or updated with `execution/scripts/update-context-index.sh` for Work Order, connected requirements, connected blueprints, referenced blueprints, and known delivery links
      Filled by hand, matching the precedent in this repository.

- [x] **Certification: Phase 1 complete. Proceeding to Phase 2.**
      Five criteria graded and the concrete defect identified: `searchArtifacts`
      carried no correction filter at all.

## Phase 2: Planning And Implementation

### Implementation Plan

(see `execution/writing-implementation-plans.md`)

- [x] Implementation plan documented in `implementation-plan.md`
      Written before any code. Five ordered steps, the migration sequence spelled
      out against the v50 FK-safe precedent, and an explicit section naming what
      is deliberately not moved and why.
- [x] Testing section documented in `implementation-plan.md`
      Seven scenarios, including the artifact defect on both arms and the
      supplied-fact survival case, plus the regression command and the reason
      `upgradedDatabaseMigration` and `suppliedMemory` are in it.

### Implementation

- [x] Implemented changes are scoped to the Work Order
      Three source files (`migrations.ts`, `memoryIndex.ts`, `queries.ts`) plus
      the new test. Deletion and connector-purge orchestration, semantic
      embedding, and ranking were left alone as Out of Scope requires. No
      do-not-touch file was written; `schema.ts` in particular was not edited —
      the schema change is expressed as a migration, which is sound because
      migrations run on fresh installs too.
- [x] Tests added or updated for changed behavior
      `tests/canonicalExactBoundary.test.ts`, 11 tests. The headline defect has
      its own before-and-after test. Three defects in my own work were caught by
      these tests during development and are recorded in `review-log.md`.
- [x] Documentation, generated files, fixtures, migrations, or config updated where relevant
      Migration **v70** — the only version consumed from the 70–74 range across
      this whole session so far. `MEMORY_INDEX_VERSION` bumped to 3 and the day
      fingerprint given a `website_visits` term, so already-indexed days
      re-project instead of staying page-less.

- [x] **Certification: Phase 2 complete. Proceeding to Phase 3.**

## Phase 3: Review And Verification

### Review

- [SKIP] Review subagent spawned per `execution/review-phase.md` and returned a verdict
      Skip reason: this session was directed to execute its work orders directly;
      spawning subagents was not requested. Round 1 is a self-review and says so.
- [x] All acceptance criteria from the Work Order and linked requirements are satisfied
      All five graded met in the Round 1 table, with the important qualification
      recorded rather than hidden: AC-SM-006.1 is met for the paths this work
      order moved, and limits L1 (`ai_artifacts` has no canonical projection) and
      L2 (`searchBlocks` deliberately not moved) state where it is not
      universally true.
- [x] Architecture is aligned with linked blueprints, or documented drift is accepted
      Aligned with ADR-001 and the canonical-boundary Key Contract. Two blueprint
      statements checked and found accurate, including the one about
      #TrackingHistory and #ConnectorPurge not calling #MemoryIndex — still true,
      out of scope here, and raised as a cross-lane dependency with an owner
      needed. The Factory documents were not edited.
- [SKIP] Exploratory pass on user-visible or external behavior — not only automated tests; for browser apps, use browser-based testing if available. Brief notes in `review-log.md` or evidence.
      Skip reason: the migration rebuilds a table holding real personal history,
      and this session's instruction keeps verification against real data out of
      commits. The hermetic fixtures cover the rebuild including supplied-fact
      survival. The manual check owed before release is written down in
      `review-log.md`.
- [x] Latest `review-log.md` verdict is `APPROVED`
      Round 1: APPROVED with two recorded limits.

- [x] **Certification: Phase 3 complete. Proceeding to Final Completion.**

## Final Completion Check

- [x] All phase certifications above are complete
      Phases 1, 2, and 3 certified, with two `[SKIP]` items carrying reasons.
- [x] Checklist is fully filled out with evidence
      Every item is `[x]` with evidence or `[SKIP]` with a reason.
- [x] Review log is complete (`review-log.md`)
      One round with a verdict, a criteria table, the closed defect, three
      self-caught defects recorded honestly, two limits, the blueprint check, a
      cross-lane dependency, and the migration rationale.
- [x] Implementation plan was followed (`implementation-plan.md`)
      Followed, with one planned step abandoned on evidence: the plan gave
      `searchArtifacts` a canonical arm, and testing showed the canonical
      `artifact` kind describes a different table than the one that reader
      searches. Recorded as defect 2 in `review-log.md` and as limit L1.
- [x] All intended files are present in the working tree
      `src/main/db/migrations.ts`, `src/main/services/memoryIndex.ts`,
      `src/main/db/queries.ts`, `tests/canonicalExactBoundary.test.ts`, and this
      execution directory.
- [SKIP] Work order status updated to `in_review`
      Skip reason: the board is the owner's to move, and this session reads the
      records from the on-disk export rather than calling the Factory MCP.
