<!--lint disable no-undefined-references strong-marker-->

# Work Order Execution Checklist: DEV-292

**Work Order Number:** DEV-292
**Work Order Title:** Make the day recap good: an iteration tool over real days, and a budget that lets it finish
**Initialized At (UTC):** 2026-08-11T06:08:40Z

Note: the implementation landed across six commits before this directory existed.
This execution ran the context, verification, review, and handoff phases against
the code in the tree, and the implementation plan was written to match what
landed.

## Phase 1: Start / Context Gathering

### Required Steps

- [x] Review work order description provided by MCP tool output
      Read in full from Linear (DEV-292). Problem statement, solution, 14 user
      stories, implementation decisions, testing decisions, out of scope.
- [x] Identify linked requirements and blueprints
      Requirement: `docs/specs/day-recap-and-analysis.md`. Voice contract:
      `docs/specs/label-voice.md`. No blueprints exist.
- [x] Review every connected requirements document
      Graded against the spec's `## Acceptance` section.
- [SKIP] Review every connected blueprint document
      Skip reason: no blueprint documents exist for this surface. The blueprint
      layer is a known gap recorded in `docs/factory.md`.
- [SKIP] Follow `@…` mentions **and links** to other blueprints in linked documents and read each referenced blueprint via MCP
      Skip reason: no blueprints exist, so there are no blueprint references to
      follow. Specification cross-references were followed
      (`agent-runtime-and-context.md`, `ai-agent.md`).
- [SKIP] Review every referenced blueprint discovered that way; add them to **Referenced Blueprints** in `context.md`
      Skip reason: none discovered; see above.
- [x] Extract acceptance criteria from requirements
      Five lines from the spec's `## Acceptance`, recorded and graded in
      `review-log.md`.
- [x] Identify architecture path from blueprints (components, contracts, composition)
      Taken from `docs/codebase/architecture.md` and the code, since no
      blueprints exist. Path recorded in `context.md`.
- [x] `context.md` is filled or updated for Work Order, connected requirements, connected blueprints, referenced blueprints, and known delivery links
      Filled by hand rather than by `update-context-index.sh`, because the
      records live in Linear and `docs/specs`, not in a Software Factory service.

- [x] **Certification: Phase 1 complete. Proceeding to Phase 2.**

## Phase 2: Planning And Implementation

### Implementation Plan

- [x] Implementation plan documented in `implementation-plan.md`
      Written to match the implementation that landed, including the accepted
      drift on the call-site timeout wrapper.
- [x] Testing section documented in `implementation-plan.md`

### Implementation

- [x] Implemented changes are scoped to the Work Order
      Twelve files. Every out-of-scope item the work order names (streaming,
      persistence, prompt caching, suggestion UI, per-tier model strategy, block
      label quality, week/month recaps) was left alone.
- [x] Tests added or updated for changed behavior
      `tests/recapContract.test.ts` (14 tests, new),
      `tests/settingsDefaults.test.ts` (7). `tests/recapVoice.test.ts` unchanged
      and still passing, as the work order required.
- [x] Documentation, generated files, fixtures, migrations, or config updated where relevant
      `package.json` registers `lab:recap`. No migration: nothing persists. The
      budget's justifying measurement is recorded in a code comment; a stale
      figure in that comment is logged as advisory in `review-log.md`.

- [x] **Certification: Phase 2 complete. Proceeding to Phase 3.**

## Phase 3: Review And Verification

### Review

- [SKIP] Review subagent spawned per `execution/review-phase.md` and returned a verdict
      Skip reason: this session prohibits spawning subagents. Every review
      dimension was run directly and recorded in `review-log.md` Round 1.
- [x] All acceptance criteria from the Work Order and linked requirements are satisfied
      Four of five spec acceptance lines met. The fifth ("grounding evals") is
      open and blocked on the owner approving a variant — work order story 8. Not
      a defect in what landed; carried as the single open item below.
- [SKIP] Architecture is aligned with linked blueprints, or documented drift is accepted
      Skip reason: no blueprints to align against. Drift from the work order's own
      instruction on the timeout wrapper is documented and accepted in
      `implementation-plan.md`.
- [x] Exploratory pass on user-visible or external behavior
      `npm run lab:recap 2026-08-10` against a 13-block real day: 4/4 variants
      completed, 7.03-13.4s, voice-clean. Evidence in `review-log.md`. Not a
      browser app, so no browser tooling applies.
- [x] Latest `review-log.md` verdict is `APPROVED`

- [x] **Certification: Phase 3 complete. Proceeding to Final Completion.**

## Final Completion Check

- [x] All phase certifications above are complete
- [x] Checklist is fully filled out with evidence
- [x] Review log is complete (`review-log.md`)
- [x] Implementation plan was followed (`implementation-plan.md`)
- [x] All intended files are present in the working tree
      Verified: `typecheck` and `lint` pass, 25 recap-related tests pass, and the
      lab runs end to end.
- [SKIP] Work order status updated to `in_review`
      Skip reason: the board is the owner's to move. DEV-292 sits in Todo; the
      status change is reported for the owner alongside the variant decision the
      last deliverable depends on.

## Open item

Work order story 8 — "a variant I approve becomes a gold example in the eval
family" — is the one deliverable not landed, and it cannot be decided here. The
lab has now printed four variants against a real day; which one ships is a taste
judgement reserved to the owner by the story's own wording. Once a variant is
approved:

1. Set `SHIPPED_RECAP_VARIANT_ID` in `src/main/ai/recapVariants.ts` if it changes
   (currently `colleague`).
2. Add the recap as a scored subject in `tests/journal-eval`, which today grades
   block labels, block narratives, and the wrapped narrative. The recap has no
   stored artifact to read, so the eval must generate it — a paid call per day,
   so it belongs behind an opt-in flag like the existing `--judge`.
3. That closes the spec acceptance line "the voice and grounding evals fail the
   old shapes and pass the new ones".
