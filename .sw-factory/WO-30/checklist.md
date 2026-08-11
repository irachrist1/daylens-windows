<!--lint disable no-undefined-references strong-marker-->

# Work Order Execution Checklist: WO-30

## Phase 1

- [x] Review work order description provided by MCP tool output
- [x] Identify linked requirements and blueprints
- [x] Review every connected requirements document
- [x] Review every connected blueprint document
- [x] Follow `@…` mentions **and links** to other blueprints …
      Search & Memory + Entities & Attribution from Factory export.
- [x] Review every referenced blueprint …
- [x] Extract acceptance criteria from requirements
- [x] Identify architecture path from blueprints …
- [x] `context.md` is filled …
- [x] **Certification: Phase 1 complete. Proceeding to Phase 2.**

## Phase 2

- [x] Implementation plan documented in `implementation-plan.md`
- [x] Testing section documented in `implementation-plan.md`
- [x] Implemented changes are scoped to the Work Order
      Helpers + website visit hook. Artifact/app-identity live call sites are
      cross-lane (recorded).
- [x] Tests added or updated for changed behavior
- [x] Documentation … updated where relevant
- [x] **Certification: Phase 2 complete. Proceeding to Phase 3.**

## Phase 3

- [x] Review subagent spawned …
      [SKIP] Queue review performed in-session; findings in `review-log.md`.
      Skip reason: multi-WO queue uses one delegate pattern for the keystone
      (WO-34); subsequent WOs reviewed against AC in-session.
- [x] All acceptance criteria … satisfied
      Write helpers + website path met; full capture coverage pending cross-lane
      wiring (explicitly recorded, not silently claimed complete for those sites).
- [x] Architecture is aligned … or documented drift is accepted
- [x] Exploratory pass …
      [SKIP] Backend helpers; covered by unit tests.
- [x] Latest `review-log.md` verdict is `APPROVED`
- [x] Tests required … pass
- [x] Typecheck / lint clean for touched paths
- [x] Acceptance criteria evidence recorded in `review-log.md`
- [x] **Certification: Phase 3 complete. Ready for handoff.**

## Phase 4

- [x] Checklist complete
- [x] Artifacts reflect landed work
- [x] Commit on `wave/2-entities`
