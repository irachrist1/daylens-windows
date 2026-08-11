<!--lint disable strong-marker-->

# Review Log: WO-53

**Work Order:** WO-53 — [backend] Enforce evidence coverage for factual answers
**Initialized At (UTC):** 2026-08-11T14:44:40Z

This file records review and verification rounds. Append new rounds; do not overwrite prior rounds.

---

## Round 1

One review round was performed, by the implementer, directly on the working
tree. No second reviewer and no review subagent was used. Scope: the full
uncommitted WO-53 diff — `src/main/agent/factClaims.ts`,
`src/main/agent/deterministicFacts.ts`, `src/main/agent/evidenceCoverage.ts`,
`src/main/agent/chatAgent.ts`, `tests/agentEvidenceCoverage.test.ts`, and
`.sw-factory/WO-53/*`.

### Requirements Alignment

**Blocking (found and fixed in this round):**

- **A repair could clobber a correct component figure.** The first version
  replaced the FIRST stated duration whenever no stated duration matched the
  computed fact. For an answer shaped "Slack took 45m of your 6 hours", that
  rewrote the correct component ("45m") and left the wrong total standing,
  turning a true detail into a false one and failing AC-AIA-002.4 outright.
  Fixed by targeting the first figure the exchange's evidence cannot back,
  since a figure quoted from evidence is not the claim at issue. Regression
  test: "a component figure quoted from evidence is not mistaken for the
  headline".

- **A count repair could rewrite the digits inside a date or a clock time.**
  The first version scanned for bare integers after masking durations. For
  "On 2026-07-14, starting at 09:41, you used 9 apps", a wrong count would
  have rewritten `2026` and produced `On 12-07-14`. Fixed by making a count
  claim noun-anchored: a number is only a count when it is attached to the
  thing being counted. Regression test: "a count claim never rewrites the
  digits of a date or a clock time".

**Advisory:**

- AC-AIA-002.4 names "comparison, date, or relationship" among the eligible
  deterministic facts. This work order implements totals and counts
  (`total_tracked_time`, `focus_time`, `app_total_time`, `app_count`,
  `site_count`). Day-over-day comparisons and entity relationships are NOT
  deterministically enforced. This is a real, deliberate gap and is graded
  below rather than claimed.

- Enforcement acts only on a single headline figure per dimension. An answer
  that misstates a secondary figure is caught by the coverage pass and
  disclosed as uncertain, but is not repaired.

### Blueprint Alignment

**Blocking:**

- None.

**Advisory:**

- The AI Agent blueprint's Key Contract "Deterministic activity totals,
  counts, dates, relationships, and time intervals shall come from eligible
  structured evidence rather than a model choice" is now enforced for totals
  and counts. Time intervals were already covered by the pre-existing
  deterministic time-chunk table. Dates and relationships are not enforced.

- ADR-004's stated gap ("Broader claim coverage and hard enforcement remain
  required for every factual assertion, not only marker-formatted claims") is
  the reason `evidenceCoverage.ts` exists alongside, rather than inside,
  `contextCitations.ts`. The marker path is unchanged.

- The child blueprint Agent Runtime & Context Packet is an unfilled template
  and constrains nothing here. It was not edited.

### Architecture And Conventions

**Blocking:**

- None.

**Advisory:**

- One canonical boundary was verified by test rather than by inspection alone:
  the computed total is asserted equal to `queryCorrectedActivityFactsForDay`,
  and a Timeline deletion is asserted to move both together.

- `execGetDaySummary` (behind `get_day_overview`) still reads the uncorrected
  `getAppSummariesForRange`. Out of scope and owned by the parallel data lane.
  It is left alone deliberately; it is also what makes enforcement necessary
  rather than decorative, since a tool can hand the model an uncorrected total.

- Defect found and fixed during review, not a requirements issue: the initial
  `Write` of `deterministicFacts.ts` emitted NUL bytes in place of spaces in
  one string literal, which made `git grep` treat the file as binary. The
  affected code was removed with the count-path rewrite. All five touched
  files were then scanned and contain zero NUL bytes.

### Tests

**Blocking:**

- None.

**Advisory:**

- 23 tests in one new file. No existing test was modified, weakened, or
  deleted; `git diff --stat` touches exactly one non-new source file
  (`chatAgent.ts`) and no existing test file.

- The end-to-end tests drive `runChatAgentTurn` with `MockLanguageModelV3`
  against a synthetic database seeded in-test. No fixture contains real
  personal activity. The one credential-shaped string
  (`test-key-DO-NOT-LEAK-0000`) is a synthetic value whose only purpose is to
  assert it does NOT appear in inspection output; it was deliberately written
  without a real provider key prefix.

### Verification

- `npm run typecheck`: clean.
- `npm run lint`: 0 errors, 128 warnings. All warnings are pre-existing
  `@typescript-eslint/no-explicit-any` across the repo; none are in the new
  files. One error was introduced and fixed during this round: a date in a
  comment in the new test file tripping `local/no-meta-commentary`.
- `npm test agentEvidenceCoverage`: 23 pass, 0 fail.
- Full `npm test` on the final tree: **328 files, 2218 pass, 0 fail, 11 skip**,
  152.3s. `tests/captureSpool.test.ts`, a known timing flake under parallel
  load, passed without a re-run.

Note on `tests/captureHelperNeverGuess.test.ts`: it failed 6/6 on the first
full run in this worktree with "missing helper binary at build/capture-helper".
That is an unbuilt native artifact, not a regression. `npm run
build:capture-helper` was run and the file then passed 6/6. The binary is
gitignored and is not part of the commit.

### Grading Against Acceptance Criteria

- **AC-AIA-002.4 — MET for totals and counts, NOT MET for comparisons, dates,
  and relationships.** Eligible totals and counts are computed from the
  canonical corrected boundary and enforced against the finished answer, with
  an end-to-end test proving a wrong model figure does not reach the user.
  Comparison, date, and relationship facts named in the criterion are not
  deterministically computed or enforced.

- **AC-AIA-002.1 — PARTIALLY MET.** Durations, clock times, calendar dates,
  and named entities are extracted and bound to the identity of the evidence
  item backing them, and unbacked figures produce an explicit
  evidence-unavailable statement. The criterion also names relationships,
  people, projects, files, meetings, and activities as claim types. Those are
  only covered insofar as the existing narrow `extractNamedEntities` picks
  them up, which it does for quoted strings and filename-shaped tokens and
  not for conversational mentions. Widening the extractor was rejected in this
  round: the existing comment in `src/main/ai/citations.ts` records that
  looser matching produced enough false positives to wreck correct answers,
  and a false "evidence unavailable" line is a worse product defect than a
  missed binding.

- **AC-AIA-002.2 — MET for figures, PARTIALLY MET in general.** An unsupported
  duration is named specifically and marked uncertain rather than presented as
  known, with the original answer preserved underneath, and the sentence is
  asserted against the banned-vocabulary list and the em-dash ban. Unsupported
  non-figure claims are recorded in `unsupportedClaims` for inspection but are
  deliberately not surfaced in prose, for the false-positive reason above.

- **AC-AIA-002.3 — MET as far as this work order's own output goes, NOT
  independently verified for the shipped inspector UI.** The evidence index is
  built only from the turn's packet, its successful tool results, and its
  computed facts, and an end-to-end test plants a distinctive system
  directive, a distinctive provider key, and unrelated thread history and
  asserts none of them appear in the serialized evidence, citations, or tool
  trace, while the evidence is non-empty. What was NOT verified: the renderer
  path that displays this to a person. `ChatAgentResult.evidence` is returned
  but no UI consumes it yet, and `src/main/services/contextPacketInspection.ts`
  (the existing inspector, which already claims this property for the packet)
  was not extended to surface the new coverage record. A person inspecting an
  answer today still sees citations and tool trace, not claim bindings.

### Not Verified

Stated plainly rather than implied:

- No exploratory pass in the running desktop app. The app was not launched,
  because doing so reads the live user database this work order is forbidden
  to touch. No human has read a repaired answer in the real chat UI.
- No run against a real provider. All model behaviour is mocked.
- The six unresolved comment threads on the AI Agent blueprint were listed by
  the MCP read but their contents were not fetched, so nothing here responds
  to them.
- `ChatAgentResult.evidence` is not persisted with the message and not
  rendered. Making the coverage record durable and inspectable in the UI is
  follow-on work.

### Verdict

**APPROVED WITH DOCUMENTED GAPS.**

The criterion this work order was created to close, AC-AIA-002.4, is met for
the totals and counts that DEV-246 is about, and is proven by an end-to-end
test. AC-AIA-002.1, .2, and .3 are met in the answer pipeline but each carries
a named limitation above. The honest summary is: the enforcement half is real
and tested; the inspection surface exists in the result contract but has no UI
consumer yet.
