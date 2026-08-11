<!--lint disable no-undefined-references strong-marker-->

# Work Order Execution Checklist: WO-99

**Work Order Number:** WO-99
**Work Order Title:** [backend] Define the common interpretation and activity-description contract
**Initialized At (UTC):** 2026-08-11T08:32:45Z

**Execution state: complete. Verdict APPROVED in `review-log.md`.**

## Phase 1: Start / Context Gathering

### Required Steps

- [x] Review work order description provided by MCP tool output
      Read in full from the 2026-08-11 Factory export
      (`~/Downloads/daylens-work-orders-2026-08-11-092326.csv`). Summary, In
      Scope, Out of Scope, and the embedded REQ-VIC-001 and REQ-VIC-003. The MCP
      was not called; the export is this execution's source of record.
- [x] Identify linked requirements and blueprints
      Blueprint: **Voice & Interpretation Contract**
      (`54e028ec-b55e-4036-9799-ddc78d568584`). The `Requirement IDs` column is
      empty; the governing requirements are embedded in the description and
      belong to the Voice & Interpretation Contract requirement node
      (`cf885bbe-b4ce-4ba1-b6e5-4813f57949aa`). Recorded in `context.md`.
- [x] Review every connected requirements document
      REQ-VIC-001 (four criteria) and REQ-VIC-003 (three criteria) graded
      criterion by criterion in `context.md`, each against the code as it stood
      before this work order.
- [x] Review every connected blueprint document
      Voice & Interpretation Contract read in full, including its component
      definitions, Key Contracts, Integration Contracts, and both ADRs. ADR-002
      ("Separate interpretation from expression") is what keeps `summaryVoice.ts`
      out of this work order.
- [x] Follow `@…` mentions **and links** to other blueprints in linked documents and read each referenced blueprint via MCP
      The governing blueprint states that no Component Blueprint documents this
      capability and names the modules it composes. Followed those to Voice &
      Label Policy, Day Recap & Analysis, Wrapped, and Corrected Activity Facts.
      Read from the export rather than via MCP, matching the DEV-292 and WO-1
      precedents in this repository.
- [x] Review every referenced blueprint discovered that way; add them to **Referenced Blueprints** in `context.md`
      Four listed in `context.md` with why each was reached and what it
      constrains.
- [x] Extract acceptance criteria from requirements
      Seven criteria (AC-VIC-001.1 through .4, AC-VIC-003.1 through .3), each
      mapped to a verified defect or to a partial-met finding, in `context.md`.
- [x] Identify architecture path from blueprints (components, contracts, composition)
      `#LabelVoicePolicy` and `#GeneratedVoiceContract` are the two components
      this work order converges. File-level path in `context.md`.
- [x] `context.md` is filled or updated with `execution/scripts/update-context-index.sh` for Work Order, connected requirements, connected blueprints, referenced blueprints, and known delivery links
      Filled by hand rather than by the script, matching the DEV-292 and WO-1
      precedents: the records were read from the on-disk export, not resolved
      live.

- [x] **Certification: Phase 1 complete. Proceeding to Phase 2.**
      Seven acceptance criteria extracted, one governing and four referenced
      blueprints read, four defects (D1-D4) verified against the code.

## Phase 2: Planning And Implementation

### Implementation Plan

(see `execution/writing-implementation-plans.md`)

- [x] Implementation plan documented in `implementation-plan.md`
      Written before any code. Five ordered steps; the constraint that drives the
      design (two plumbing scopes, one definition site) is stated in step 1.
- [x] Testing section documented in `implementation-plan.md`
      Eight scenarios, one per acceptance criterion clause, plus the scope-
      separation regression. Names the three existing test files that must stay
      green untouched as the no-drift proof.

### Implementation

- [x] Implemented changes are scoped to the Work Order
      One new file (`src/shared/activityDescription.ts`) and two files pointed at
      it (`src/shared/labelVoice.ts`, `src/main/ai/voiceContract.ts`). No
      consumer was wired: prompt composition, label finalization, and time-chunk
      wording are this work order's stated Out of Scope and were not touched.
- [x] Tests added or updated for changed behavior
      `tests/activityDescriptionPolicy.test.ts`, 18 tests. Every fixture is
      invented activity (an invented client, an invented project, invented
      titles); no real recap, label, or narrative entered the repository.
- [x] Documentation, generated files, fixtures, migrations, or config updated where relevant
      No migration: this work order stores nothing, so the lane's reserved range
      85-89 is untouched. No generated files or config. The rationale that lives
      in comments (why each vocabulary list is narrow) moved with the terms
      rather than being lost in the refactor.

- [x] **Certification: Phase 2 complete. Proceeding to Phase 3.**

## Phase 3: Review And Verification

### Review

- [SKIP] Review subagent spawned per `execution/review-phase.md` and returned a verdict
      Skip reason: this session runs under a harness policy that forbids spawning
      agents unless the person explicitly asks, and they did not. The review round
      was run in-session instead and is recorded in `review-log.md` Round 1, with
      the method stated so the difference is visible rather than implied.
- [x] All acceptance criteria from the Work Order and linked requirements are satisfied
      Seven-row criterion table in `review-log.md`. Five are graded "met as a
      primitive" rather than "met", because every consumer is out of this work
      order's scope; the distinction is stated there so nothing reads as though
      the product already behaves this way.
- [x] Architecture is aligned with linked blueprints, or documented drift is accepted
      Aligned with ADR-002 of the governing blueprint. Two discrepancies recorded
      under Blueprint Alignment: the codebase violated ADR-002 of Voice & Label
      Policy and now does not, and the governing blueprint understates the
      starting state. No Factory document was edited.
- [SKIP] Exploratory pass on user-visible or external behavior — not only automated tests; for browser apps, use browser-based testing if available. Brief notes in `review-log.md` or evidence.
      Skip reason: this work order changes no user-visible surface. Every
      consumer is explicitly out of scope, so there is nothing to open and look
      at. The obligation transfers to WO-104 through WO-106, where the policy
      reaches a screen. Recorded in `review-log.md`.
- [x] Latest `review-log.md` verdict is `APPROVED`
      Round 1, with two implementation defects found and fixed during the round
      and two limits (F1, F2) recorded rather than chased.

- [x] **Certification: Phase 3 complete. Proceeding to Final Completion.**

## Final Completion Check

- [x] All phase certifications above are complete
- [x] Checklist is fully filled out with evidence
      Every item is `[x]` with evidence or `[SKIP]` with a reason.
- [x] Review log is complete (`review-log.md`)
      One round, verdict APPROVED, with method, criterion table, defects fixed,
      deliberate behaviour change, two recorded limits, blueprint alignment, and
      test evidence.
- [x] Implementation plan was followed (`implementation-plan.md`)
      All five steps executed as written. The plan's testing section is the test
      file that landed.
- [x] All intended files are present in the working tree
      `src/shared/activityDescription.ts`, `src/shared/labelVoice.ts`,
      `src/main/ai/voiceContract.ts`, `tests/activityDescriptionPolicy.test.ts`.
- [SKIP] Work order status updated to `in_review`
      Skip reason: the board is the owner's to move, and this lane was told to
      read the records from the on-disk export rather than call the MCP. Every
      one of the 131 exported work orders reads Backlog, so the column carries no
      information to update against.
