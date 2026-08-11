<!--lint disable no-undefined-references strong-marker-->

# Work Order Execution Checklist: WO-105

**Work Order Number:** WO-105
**Work Order Title:** [backend] Apply the selected tone and description policy to agent responses
**Initialized At (UTC):** 2026-08-11T08:32:45Z

**Execution state: complete. Verdict APPROVED in `review-log.md`, with one
process defect recorded against this execution: the code was written before the
implementation plan. See Phase 2.**

## Phase 1: Start / Context Gathering

### Required Steps

- [x] Review work order description provided by MCP tool output
      Read in full from the 2026-08-11 Factory export. Summary, In Scope, Out of
      Scope, and the embedded REQ-VIC-001, REQ-VIC-002, and REQ-VIC-003.
- [x] Identify linked requirements and blueprints
      Blueprint: **Voice & Interpretation Contract**
      (`54e028ec-b55e-4036-9799-ddc78d568584`). Requirements embedded in the
      description. Recorded in `context.md`.
- [x] Review every connected requirements document
      All three requirements graded for the agent surface specifically in
      `context.md`, criterion by criterion, rather than reusing WO-99's grading.
- [x] Review every connected blueprint document
      Voice & Interpretation Contract read in full. Its two statements about
      `#AgentSystemPromptBuilder` were both accurate, which is worth noting
      because three other statements in the same blueprint were not.
- [x] Follow `@…` mentions **and links** to other blueprints in linked documents and read each referenced blueprint via MCP
      Followed to Voice & Label Policy, Desktop Application (Electron), and Day
      Recap & Analysis. Read from the export, matching the DEV-292 precedent.
- [x] Review every referenced blueprint discovered that way; add them to **Referenced Blueprints** in `context.md`
      Three listed with why each was reached. Desktop Application mattered
      practically: it is how the tone was threaded without widening any surface.
- [x] Extract acceptance criteria from requirements
      Seven criteria graded in `context.md`.
- [x] Identify architecture path from blueprints (components, contracts, composition)
      `#AgentSystemPromptBuilder` consuming `#SummaryVoiceDirective` and the
      shared policy. File-level path in `context.md`.
- [x] `context.md` is filled or updated with `execution/scripts/update-context-index.sh` for Work Order, connected requirements, connected blueprints, referenced blueprints, and known delivery links
      Filled by hand, as in the earlier work orders of this lane.

- [x] **Certification: Phase 1 complete. Proceeding to Phase 2.**
      Seven criteria extracted, three blueprints read, three defects verified,
      plus one prompt conflict found while sizing them.

## Phase 2: Planning And Implementation

### Implementation Plan

(see `execution/writing-implementation-plans.md`)

- [x] Implementation plan documented in `implementation-plan.md`
      Three steps and the optional-tone design note. **Written AFTER the code,
      not before it, which the process forbids.** WO-99, WO-102, and WO-104 each
      had their plan first; this one did not. The plan describes what landed, so
      it is accurate, but the order was wrong and it is recorded rather than
      backdated. Consequence named in `review-log.md`: the prompt conflict was
      found while composing rather than while planning, which is where a plan
      would have caught it.
- [x] Testing section documented in `implementation-plan.md`
      Seven scenarios plus the two regression files that had to stay green.

### Implementation

- [x] Implemented changes are scoped to the Work Order
      `systemPrompt.ts` (the named component), three lines in `chatAgent.ts`, two
      lines in `aiService.ts`'s prompt-building region, one directive rewording
      in `activityDescription.ts`. Time-chunk rendering, Wrapped, and the brief
      were not touched, matching the Out of Scope list. No do-not-touch file was
      edited.
- [x] Tests added or updated for changed behavior
      `tests/agentVoiceContract.test.ts`, 9 tests. No fixture contains real
      activity; the file builds prompts and reads constants.
- [x] Documentation, generated files, fixtures, migrations, or config updated where relevant
      No migration; range 85-89 untouched. The reasoning that had to survive is
      written where it applies: why the tone is optional at every hop and
      normalizes at the last one.

- [x] **Certification: Phase 2 complete, with the ordering defect above recorded.**

## Phase 3: Review And Verification

### Review

- [SKIP] Review subagent spawned per `execution/review-phase.md` and returned a verdict
      Skip reason: the harness forbids spawning agents unless the person asks,
      and they did not. Reviewed in-session; method stated in `review-log.md`.
- [x] All acceptance criteria from the Work Order and linked requirements are satisfied
      Seven-row table in `review-log.md`. AC-VIC-003.1 is marked "advanced, not
      closed" rather than met, because the agent is instructed to state a limit
      but is not handed a `SupportedInterpretation` to produce one from. F1
      records the broader point: everything added here is prompt text, so the
      agent is told the policy, not held to it at runtime.
- [x] Architecture is aligned with linked blueprints, or documented drift is accepted
      Aligned. No discrepancy for this work order: both blueprint statements
      about `#AgentSystemPromptBuilder` were accurate and both gaps are closed.
- [SKIP] Exploratory pass on user-visible or external behavior — not only automated tests; for browser apps, use browser-based testing if available. Brief notes in `review-log.md` or evidence.
      Skip reason: asking the agent the same question under two tones needs a
      configured provider, the owner's real database, and two live turns, and the
      repository is public so the answers could not be recorded. Stated in full
      in `review-log.md` and flagged for the final reviewer.
- [x] Latest `review-log.md` verdict is `APPROVED`

- [x] **Certification: Phase 3 complete. Proceeding to Final Completion.**

## Final Completion Check

- [x] All phase certifications above are complete
- [x] Checklist is fully filled out with evidence
- [x] Review log is complete (`review-log.md`)
      One round: method, the process defect, criterion table, the prompt conflict
      and why it was worth stopping for, one recorded limit, cross-lane
      dependencies, blueprint alignment, the briefing's finding 1 reconciled,
      tests, exploratory pass.
- [x] Implementation plan was followed (`implementation-plan.md`)
      The landed change matches all three steps. The plan was written after them,
      which is recorded above and not glossed.
- [x] All intended files are present in the working tree
      `src/main/agent/systemPrompt.ts`, `src/main/agent/chatAgent.ts`,
      `src/main/jobs/aiService.ts`, `src/shared/activityDescription.ts`,
      `tests/agentVoiceContract.test.ts`.
- [SKIP] Work order status updated to `in_review`
      Skip reason: the board is the owner's to move, and this lane reads the
      records from the on-disk export rather than calling the MCP.
