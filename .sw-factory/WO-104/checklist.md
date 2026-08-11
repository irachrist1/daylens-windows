<!--lint disable no-undefined-references strong-marker-->

# Work Order Execution Checklist: WO-104

**Work Order Number:** WO-104
**Work Order Title:** [backend] Wire common interpretation and tone into Wrapped and brief prompts
**Initialized At (UTC):** 2026-08-11T08:32:45Z

**Execution state: complete. Verdict APPROVED in `review-log.md`.**

## Phase 1: Start / Context Gathering

### Required Steps

- [x] Review work order description provided by MCP tool output
      Read in full from the 2026-08-11 Factory export. Summary, In Scope, Out of
      Scope, and the embedded REQ-VIC-002.
- [x] Identify linked requirements and blueprints
      Blueprint: **Voice & Interpretation Contract**
      (`54e028ec-b55e-4036-9799-ddc78d568584`). Requirement embedded in the
      description. Recorded in `context.md`.
- [x] Review every connected requirements document
      REQ-VIC-002's three criteria graded individually in `context.md`, each
      against the code as it stood: .1 and .2 unmet, .3 partially met.
- [x] Review every connected blueprint document
      Voice & Interpretation Contract read in full. Its Integration Contract
      "Fact validation remains independent of tone selection" is the constraint
      the implementation had to respect and the 89 untouched wrap-validation
      passes are the evidence that it did.
- [x] Follow `@…` mentions **and links** to other blueprints in linked documents and read each referenced blueprint via MCP
      Followed to Wrapped, Day Recap & Analysis, Apps, and Voice & Label Policy.
      Read from the export, matching the DEV-292 and WO-1 precedents.
- [x] Review every referenced blueprint discovered that way; add them to **Referenced Blueprints** in `context.md`
      Four listed with why each was reached.
- [x] Extract acceptance criteria from requirements
      Three criteria (AC-VIC-002.1 through .3) in `context.md`.
- [x] Identify architecture path from blueprints (components, contracts, composition)
      `#SummaryVoiceDirective` into `#NarrativePromptComposer`. Established that
      "the brief" is the day recap and that no Proactive Brief composer exists;
      the evidence is in `context.md` under "What 'the brief' actually is".
- [x] `context.md` is filled or updated with `execution/scripts/update-context-index.sh` for Work Order, connected requirements, connected blueprints, referenced blueprints, and known delivery links
      Filled by hand, as in WO-99 and WO-102.

- [x] **Certification: Phase 1 complete. Proceeding to Phase 2.**
      Three acceptance criteria extracted, four blueprints read, four defects
      (D1-D4) verified, and one tempting change checked and deliberately not
      made (stored-wrap re-voicing).

## Phase 2: Planning And Implementation

### Implementation Plan

(see `execution/writing-implementation-plans.md`)

- [x] Implementation plan documented in `implementation-plan.md`
      Written before any code. Six steps. The directive split is argued in
      Components And Flow rather than done silently, because it changes a
      constant WO-99 shipped.
- [x] Testing section documented in `implementation-plan.md`
      Seven scenarios including the prompt-does-not-argue-with-itself check.

### Implementation

- [x] Implemented changes are scoped to the Work Order
      `activityDescription.ts` (directive split), the three Wrapped composers,
      and `aiService.ts`'s prompt-building region. Wrapped deck validation, the
      deterministic fallback, agent prompts, and time-chunk wording were not
      touched, matching the Out of Scope list.
- [x] Tests added or updated for changed behavior
      `tests/toneAcrossSurfaces.test.ts`, 9 tests. No fixture contains real
      activity; the file reads source text and tone constants only.
- [x] Documentation, generated files, fixtures, migrations, or config updated where relevant
      `DAY_WRAP_PROMPT_VERSION` 2 to 3 and `PERIOD_WRAP_PROMPT_VERSION` 1 to 2,
      because the analysis ledger records which prompt wrote a wrap and the
      prompts changed. No migration; range 85-89 untouched.

- [x] **Certification: Phase 2 complete. Proceeding to Phase 3.**

## Phase 3: Review And Verification

### Review

- [SKIP] Review subagent spawned per `execution/review-phase.md` and returned a verdict
      Skip reason: the harness forbids spawning agents unless the person asks,
      and they did not. Reviewed in-session; method stated in `review-log.md`.
- [x] All acceptance criteria from the Work Order and linked requirements are satisfied
      Three-row table in `review-log.md`. AC-VIC-002.2 is marked met "for the
      five surfaces in scope", with the agent named as WO-105's and deliberately
      not counted.
- [x] Architecture is aligned with linked blueprints, or documented drift is accepted
      Aligned with "fact validation remains independent of tone selection", with
      89 untouched validation passes as the evidence. One discrepancy recorded:
      the Proactive Brief named in the blueprint does not exist in the codebase.
- [SKIP] Exploratory pass on user-visible or external behavior — not only automated tests; for browser apps, use browser-based testing if available. Brief notes in `review-log.md` or evidence.
      Skip reason: switching tone and reopening the recap needs the Electron app,
      the owner's real database, and a live provider call per tone, and the
      repository is public so the output could not be recorded. Stated in full in
      `review-log.md`, including what the hermetic tests do and do not prove, and
      flagged for the final reviewer.
- [x] Latest `review-log.md` verdict is `APPROVED`

- [x] **Certification: Phase 3 complete. Proceeding to Final Completion.**

## Final Completion Check

- [x] All phase certifications above are complete
- [x] Checklist is fully filled out with evidence
- [x] Review log is complete (`review-log.md`)
      One round: method, criterion table, the briefing's finding closed with the
      reasoning for its placement, three further defects, one known limit, one
      deliberate exclusion, cross-lane dependencies, blueprint alignment, tests,
      exploratory pass.
- [x] Implementation plan was followed (`implementation-plan.md`)
      All six steps executed as written.
- [x] All intended files are present in the working tree
      `src/shared/activityDescription.ts`, `src/main/lib/wrappedNarrative.ts`,
      `src/main/lib/wrappedPeriodNarrative.ts`,
      `src/main/services/wrappedQuestion.ts`, `src/main/jobs/aiService.ts`,
      `tests/toneAcrossSurfaces.test.ts`.
- [SKIP] Work order status updated to `in_review`
      Skip reason: the board is the owner's to move, and this lane reads the
      records from the on-disk export rather than calling the MCP.
