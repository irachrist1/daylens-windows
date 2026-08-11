<!--lint disable no-undefined-references strong-marker-->

# Work Order Execution Checklist: WO-6

**Work Order Number:** WO-6
**Work Order Title:** [backend] Restore the unified search handler and filter contract
**Initialized At (UTC):** 2026-08-11T09:15:00Z

**Execution state: all three phases complete. Verdict APPROVED with one recorded gap.**

## Phase 1: Start / Context Gathering

### Required Steps

- [x] Review work order description provided by MCP tool output
      Read in full from the on-disk Factory export. Summary, In Scope, Out of
      Scope, and the embedded REQ-SM-002 with three acceptance criteria.
- [x] Identify linked requirements and blueprints
      Blueprint: **Search & Memory** (`cb4a2742-367c-42c2-858a-07a41e887a46`).
      `Requirement IDs` is empty in the export; REQ-SM-002 is embedded in the
      description. Recorded in `context.md`.
- [x] Review every connected requirements document
      Search & Memory requirements read in full during WO-7 and re-read for
      REQ-SM-002's three criteria, each graded against the code in `context.md`.
- [x] Review every connected blueprint document
      Search & Memory read in full, with attention to the Integration Contracts
      section that specifies this boundary — the eight channels, the preload
      bridge, and the `SearchOptions` gap.
- [x] Follow `@…` mentions **and links** to other blueprints in linked documents and read each referenced blueprint via MCP
      Entities & Attribution, the only outbound blueprint link. Relevant here
      because the project, client, person, and meeting filters are expressed in
      its entity ids.
- [x] Review every referenced blueprint discovered that way; add them to **Referenced Blueprints** in `context.md`
      Listed with why it was reached.
- [x] Extract acceptance criteria from requirements
      Three criteria graded with file:line evidence in `context.md`: one unmet
      except for date, one met, one partly met.
- [x] Identify architecture path from blueprints (components, contracts, composition)
      Three layers recorded in `context.md`, in the order the filters travel:
      the `SearchOptions` contract, the readers that enforce it, and the handler
      plus AI-context boundary that carries it.
- [x] `context.md` is filled or updated with `execution/scripts/update-context-index.sh` for Work Order, connected requirements, connected blueprints, referenced blueprints, and known delivery links
      Filled by hand, matching the precedent in this repository.

- [x] **Certification: Phase 1 complete. Proceeding to Phase 2.**
      Three criteria graded, both blueprints read, and the work order's own
      premise checked against the code and found stale — recorded rather than
      accepted.

## Phase 2: Planning And Implementation

### Implementation Plan

(see `execution/writing-implementation-plans.md`)

- [x] Implementation plan documented in `implementation-plan.md`
      Written before any code. Six ordered steps, the full contract shape, and a
      per-reader eligibility table so the enforcement rule is decided on paper
      rather than improvised per query.
- [x] Testing section documented in `implementation-plan.md`
      Eight scenarios specified, including the leak case that motivates the
      eligibility rule, plus the regression command and why the existing suites
      are run.

### Implementation

- [x] Implemented changes are scoped to the Work Order
      Five files: `src/main/db/queries.ts` (contract and enforcement),
      `src/main/ipc/search.handlers.ts` (the unified channel),
      `src/preload/index.ts` (the bridge and its mirrored types),
      `src/main/services/contextPacket.ts` (AI context inherits the filters), and
      the new test. Retrieval planning, ranking, and renderer presentation were
      left alone as Out of Scope requires. No do-not-touch file was written.
- [x] Tests added or updated for changed behavior
      `tests/searchFilters.test.ts`, 12 tests. Every criterion covered; the leak
      case has two tests of its own because it is the failure the eligibility
      rule exists to prevent.
- [x] Documentation, generated files, fixtures, migrations, or config updated where relevant
      No migration and no schema change: the filters read columns that already
      exist (`app_bundle_id`, `app_name`, `memory_type`, `memory_record_entities`,
      `domain`, `browser_bundle_id`). No allocation from the assigned 70–74 range
      was used. The preload's mirrored `SearchOptions` and the new response types
      were updated in step, since the bridge duplicates rather than imports them.

- [x] **Certification: Phase 2 complete. Proceeding to Phase 3.**

## Phase 3: Review And Verification

### Review

- [SKIP] Review subagent spawned per `execution/review-phase.md` and returned a verdict
      Skip reason: this session was directed to execute its five work orders
      directly; spawning subagents was not requested. Round 1 in `review-log.md`
      is a self-review and says so.
- [x] All acceptance criteria from the Work Order and linked requirements are satisfied
      All three graded met in the Round 1 table, each with its implementing code
      and covering test. One gap recorded separately — no surface sets filters
      yet — which is a missing user gesture, not an unmet criterion.
- [x] Architecture is aligned with linked blueprints, or documented drift is accepted
      The Integration Contracts gap the blueprint names is closed. Two false
      blueprint statements found (the handler module is present, not absent) and
      built against the code instead; recorded under Blueprint Alignment in both
      `context.md` and `review-log.md`. The Factory documents were not edited.
- [SKIP] Exploratory pass on user-visible or external behavior — not only automated tests; for browser apps, use browser-based testing if available. Brief notes in `review-log.md` or evidence.
      Skip reason: no surface sets a filter, so there is no user gesture to
      exercise. The check to run once a filter UI exists is written down in
      `review-log.md`.
- [x] Latest `review-log.md` verdict is `APPROVED`
      Round 1: APPROVED with one recorded gap.

- [x] **Certification: Phase 3 complete. Proceeding to Final Completion.**

## Final Completion Check

- [x] All phase certifications above are complete
      Phases 1, 2, and 3 certified, with two `[SKIP]` items carrying reasons.
- [x] Checklist is fully filled out with evidence
      Every item is `[x]` with evidence or `[SKIP]` with a reason.
- [x] Review log is complete (`review-log.md`)
      One round with a verdict, a criteria table, the eligibility decision
      defended, one recorded gap, the blueprint discrepancy, a cross-lane note on
      `queries.ts`, and the test evidence.
- [x] Implementation plan was followed (`implementation-plan.md`)
      Followed as written; no deviation.
- [x] All intended files are present in the working tree
      `src/main/db/queries.ts`, `src/main/ipc/search.handlers.ts`,
      `src/preload/index.ts`, `src/main/services/contextPacket.ts`,
      `tests/searchFilters.test.ts`, and this execution directory.
- [SKIP] Work order status updated to `in_review`
      Skip reason: the board is the owner's to move, and this session reads the
      records from the on-disk export rather than calling the Factory MCP.
