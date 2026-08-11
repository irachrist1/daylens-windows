<!--lint disable no-undefined-references strong-marker-->

# Work Order Execution Checklist: WO-53

**Work Order Number:** WO-53
**Work Order Title:** [backend] Enforce evidence coverage for factual answers
**Initialized At (UTC):** 2026-08-11T14:44:40Z

## Phase 1: Start / Context Gathering

### Required Steps

- [x] Review work order description provided by MCP tool output
      `read_work_order(53)` returned the summary, in/out of scope, and
      REQ-AIA-002 with all four acceptance criteria.
- [x] Identify linked requirements and blueprints
      REQ-AIA-002 and the AI Agent blueprint
      (`0bbc0ff1-fccd-4b18-bf28-50d0b08b67cf`).
- [x] Review every connected requirements document
      REQ-AIA-002 was read in full from the work order description. No separate
      requirements document ID was linked, so `read_requirement` was not called.
- [x] Review every connected blueprint document
      `read_blueprint(0bbc0ff1-…)` read all 152 lines: feature summary,
      component composition, `#ChatAgent` / `#DaylensReadTools` /
      `#TimeChunkAnswerRenderer` definitions, Key Contracts, Integration
      Contracts, and ADR-001 through ADR-004.
- [x] Follow links to other blueprints in linked documents and read each referenced blueprint via MCP
      The AI Agent blueprint names two children. Agent Runtime & Context Packet
      (`b3ed6474-…`) was read via MCP; it is an unfilled template. Corrections
      & Actions in Chat (`952e0de6-…`) was not read, because the blueprint
      states it owns confirmation and mutation mechanics, which this work order
      does not touch. Recorded in `context.md`.
- [x] Review every referenced blueprint discovered that way; add them to **Referenced Blueprints** in `context.md`
      Both children are listed in `context.md` with what was and was not read.
- [x] Extract acceptance criteria from requirements
      All four recorded verbatim in `context.md`, along with the two Key
      Contracts and the ADR-004 gap statement this work order closes.
- [x] Identify architecture path from blueprints (components, contracts, composition)
      `#ChatAgent` owns the post-stream answer pipeline; enforcement is
      inserted into it rather than becoming a parallel path. The canonical
      corrected-facts boundary was located and verified as the shared source
      for Timeline and Apps. Recorded in `context.md`.
- [x] `context.md` is filled for Work Order, connected requirements, connected blueprints, referenced blueprints, and known delivery links
      Written by hand (no `update-context-index.sh` in this worktree), with the
      branch and base commit recorded.

- [x] **Certification: Phase 1 complete. Proceeding to Phase 2.**

## Phase 2: Planning And Implementation

### Implementation Plan

- [x] Implementation plan documented in `implementation-plan.md`
- [x] Testing section documented in `implementation-plan.md`

### Baseline

- [x] Known-good starting point confirmed before any change
      `npm test aiTurnEndToEnd` on `wave/1-runtime-fixed` (`c179bbec`): 1 file,
      1 pass, 0 fail.
- [x] Branch created from the specified base
      `wave/6-answers` from `wave/1-runtime-fixed`. The branch name already
      existed, pointing at an unrelated commit (`373d1b45`, the
      `factory/v2-ship` head) and checked out in the empty placeholder worktree
      `/Users/tonny/Dev-Personal/dl-6-answers`. That worktree had no commits,
      no `node_modules`, and a clean tree, so its HEAD was detached and the
      branch repointed at the correct base. Nothing was lost: `373d1b45`
      remains reachable from `factory/v2-ship`.

### Implementation

- [x] Deterministic results applied for eligible totals and counts
      `src/main/agent/deterministicFacts.ts`, computed from
      `queryCorrectedActivityFactsForDay`.
- [x] Factual claims needing evidence coverage are detected
      `extractFactualClaims` in `src/main/agent/evidenceCoverage.ts`, over the
      shared scanners in `src/main/agent/factClaims.ts`.
- [x] Supported claims bound to inspectable citations from the same exchange
      `buildExchangeEvidence` + `assessEvidenceCoverage`; every binding carries
      the evidence item's identity, kind, and statement.
- [x] Out-of-scope areas untouched
      No change to context-packet assembly or disclosure persistence
      (`contextPacket.ts` untouched), no change to time-chunk presentation
      formatting (`timeChunkAnswer.ts` untouched), no change to tool-output
      isolation.
- [x] Exactly one definition of activity, time, and attribution preserved
      No new activity computation. Date scope comes from the packet's existing
      resolved time range; app rollup reuses `aggregateAppSummaries` with the
      canonical-identity links.

## Phase 3: Review And Verification

### Review

- [x] Review round recorded in `review-log.md`
      One round, performed directly. Recorded honestly, including the two
      defects it found and the items that could not be verified.
- [x] Defects found in review were fixed and re-verified
      Two blocking defects found and fixed: a repair could clobber a correct
      component figure, and a count repair could rewrite the digits inside a
      date or clock time. Both now have dedicated regression tests.

### Verification

- [x] Typecheck passes
      `npm run typecheck`: clean.
- [x] Lint passes
      `npm run lint`: 0 errors (128 pre-existing `any` warnings across the
      repo, none in the new files). One error in the new test file was found
      and fixed: a date in a comment tripping `local/no-meta-commentary`.
- [x] New tests genuinely exercise each acceptance criterion
      `tests/agentEvidenceCoverage.test.ts`, 23 tests, grouped by criterion.
      Includes the required end-to-end test that a model returning a wrong
      number for an eligible deterministic fact does not reach the user.
- [x] Full test suite run with counts recorded
      See `review-log.md` Round 1 Verification.
- [x] No existing test weakened or deleted
      `git diff` touches no existing test file. The only non-new source file
      changed is `src/main/agent/chatAgent.ts`.
- [SKIP] Exploratory pass on user-visible behavior in the running app
      Skip reason: this is backend answer-pipeline enforcement with no new UI
      surface, and launching the desktop app would read the live user database,
      which this work order is forbidden to touch. The observable contract is
      covered by end-to-end turns through `runChatAgentTurn` and `sendMessage`
      against synthetic databases. This is a genuine coverage gap, not a pass:
      no human has read a repaired answer in the real chat UI.
- [x] Latest `review-log.md` verdict recorded

- [x] **Certification: Phase 3 complete.**

## Final Completion Check

- [x] All phase certifications above are complete
- [x] Checklist is fully filled out with evidence
- [x] Review log is complete (`review-log.md`)
- [x] Implementation plan was followed (`implementation-plan.md`)
- [x] All intended files are present in the working tree
- [SKIP] Work order status updated to `in_progress` / `in_review` via MCP
      Skip reason: the task did not authorize writing to the Factory, and
      `edit_work_order` mutates shared project state. The local execution
      status in `context.md` is `in_review`; no external status was changed.
- [x] No AI or tool attribution anywhere in the commit
