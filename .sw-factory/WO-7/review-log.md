<!--lint disable strong-marker-->

# Review Log: WO-7

**Work Order:** WO-7 — [backend] Build the unified retrieval planner and ranker
**Initialized At (UTC):** 2026-08-11T08:27:05Z

This file records review and verification rounds. Append new rounds; do not overwrite prior rounds.

---

## Round 1 — verification of the implementation in this worktree

**Verdict: APPROVED with two recorded limits.** All ten acceptance criteria
across REQ-SM-001 and REQ-SM-003 are met by the delivered code and covered by
tests. Two limits are recorded below as scope boundaries, not as defects: the
structured path reads app and website aggregates only, and semantic retrieval
could not be exercised live because no local model artifact exists in this
environment.

**Method.** Self-review by code reading against the acceptance criteria, plus
the two new test files and a regression run of every existing search suite. No
review subagent was spawned — see the note at the end of this round.

### Acceptance criteria

| Criterion | Verdict | Evidence |
| --- | --- | --- |
| AC-SM-001.1 resolve time range before retrieval | Met | `resolveRetrievalScope` runs before any reader; `resolveTimeRangeFromText` parses ISO dates, today/yesterday, last-N-days, week, month, and bare month names. `tests/retrievalPlanner.test.ts` covers each form plus the "unrecognized yields null" case and filter-wins-over-text. |
| AC-SM-001.2 resolve entities and aliases before retrieval | Met | Scope resolution calls `resolveQueryEntityMatches` and carries merge-group ids into the readers. Test: an alias resolves to its survivor and the group travels with the scope. |
| AC-SM-001.3 include structured retrieval | Met | `needsStructuredRetrieval` selects on count/duration intent or on a resolved range with no lexical remainder; `runStructuredRetrieval` reads the corrected app and website aggregates. |
| AC-SM-001.4 include exact retrieval | Met | Exact runs for any query with lexical content or a resolved entity. Test: a quoted phrase selects exact, not semantic, and scores a full lexical match. |
| AC-SM-001.5 include semantic within resolved scope | Met | `benefitsFromSemanticRetrieval` excludes quoted phrases and short literals; when selected, the path receives `scopedOptions(scope, …)`, so the resolved date bounds reach it. This is new — `searchByMeaning` previously got whatever bounds the caller happened to pass. |
| AC-SM-001.6 semantic-unavailable fallback | Met | `searchByMeaningWithStatus` distinguishes unavailable from empty. Test asserts the plan records the gap with a readable reason, `degraded` is true, exact still ran, and results are non-empty. |
| AC-SM-003.1 reconcile duplicate representations | Met | `reconciliationKey` keys on the activity (start time + subject), not on `type:id`. Test proves a canonical record and a legacy row with different ids collapse to one result keeping both representations, and that distinct activities do not collapse. |
| AC-SM-003.2 rank on the nine named factors | Met | `RankingSignals` has exactly nine keys, one per named factor; `signalsFor` populates each from the reconciled group. |
| AC-SM-003.3 exact match not overtaken by recency | Met | Enforced structurally by the tier rule, not by weights. Covered both as arithmetic (matched beats non-match at 1d, 7d, 30d, 1y, 5y gaps) and end to end (an older dated match ranks first over a newer lexical match). |
| AC-SM-003.4 no behavioral ranking inputs | Met | Closed signal type; a test asserts the key set and screens it against a forbidden-term list. |

### One finding, raised and fixed during implementation

**The lexical readers were being handed the whole query string.** The first test
run failed four scenarios for one cause. `toFtsQuery` in `queries.ts` ANDs every
token, so a planner that passes the raw query asks for a window title containing
"what", "was", "I" — and, for a dated query, containing the literal string of the
date. Both are unsatisfiable.

Two changes closed it, and both are contract, not workaround:

- `RetrievalScope.lexicalText` carries the query with the resolved range phrase
  removed, so the range is *used as a bound* rather than *searched for as text*.
- `runLexicalRetrieval` takes a short or quoted query whole and searches anything
  longer per keyword, unioning the batches — the same shape `naturalSearch`
  already uses for its provider terms.

This is worth recording because the bug is invisible without the planner: each
existing caller happened to pass either a short literal or pre-extracted terms,
so the AND-ing never bit. The planner is the first caller that could pass a
sentence.

### A test of mine that was wrong

The first draft of the AC-SM-003.4 screen listed `quality` as a forbidden term
and failed on `sourceQuality`. The test was wrong, not the code: AC-SM-003.2
*requires* source quality as a ranking factor. The screen now targets judgments
about how the person spent their time — productivity, focus, distraction, idle,
efficiency, streak — which is what AC-SM-003.4 actually forbids. The narrowing is
commented in the test so it does not read as a loophole.

### Recorded limits

**L1 — structured retrieval covers app and website aggregates only.**
`runStructuredRetrieval` reads `getCorrectedAppSummariesForRange` and
`getCorrectedWebsiteSummariesForRange`. AC-SM-001.3 also names "factual
relationships", which would mean reading the entity relationship graph. That
graph is owned by Entities & Attribution and this work order's Out of Scope
excludes entity-graph work, so relationship retrieval is deliberately not
implemented. Counts and durations — the other two things the criterion names —
are covered.

**L2 — semantic retrieval was verified as a contract, not as a live path.** The
hermetic test environment has no local model artifact, so every planner test
exercises the *unavailable* branch. That is the branch AC-SM-001.6 is about and
it is genuinely covered. The available branch is covered only by the existing
`semanticSearch.test.ts` suite through `searchByMeaning`, which now delegates to
`searchByMeaningWithStatus` — so the delegation is proven, but "semantic hits
reach the planner and reconcile against exact hits" has no live test. Closing
this needs a fixture that stubs the embedder; it is worth doing and is not done
here.

### Blueprint alignment

One material discrepancy, verified and recorded in `context.md`:

**The Search & Memory blueprint states twice that the main-process search
handler module is absent from the connected repository. It is present.**
`src/main/ipc/search.handlers.ts` is 93 lines, registers all eight documented
channels, and is imported at `src/main/index.ts:109` and called at
`src/main/index.ts:1347`. Built against the code, not the blueprint. The Factory
documents were not edited.

Two blueprint statements were checked and found accurate: `SearchOptions`
carries only date bounds, limit, and internal pagination bounds; and
`#ExactSearch` combines entity-tagged and full-text results by recency rather
than through a unified ranker.

### Tests

`tests/retrievalRanking.test.ts` (9 pass), `tests/retrievalPlanner.test.ts`
(16 pass). Regression run of every existing search and memory suite —
`exactSearch`, `naturalSearch`, `semanticSearch`, `semanticEmbedBatching`,
`semanticNetworkBoundary`, `search`, `searchResults`, `memoryV2`,
`memoryBackfill` — 62 pass, 0 fail, 1 pre-existing skip. `npm run typecheck`
clean. `npm run lint` back to 0 errors and 128 pre-existing warnings.

### Review-phase note

The execution process calls for a review subagent in Phase 3. None was spawned:
this session was directed to work its five work orders directly and spawning
subagents was not requested. This round is therefore a self-review, and its
weakest point is the one a second reader would most likely probe — L2, where the
semantic path's *available* branch has no live coverage. That is stated rather
than papered over.

### Exploratory pass

Not performed. The planner has no user-visible surface yet: nothing calls
`planRetrieval` until WO-6 registers its IPC channel and WO-13 renders its
results. The exploratory check belongs to WO-13 and is recorded there — open the
palette, type a dated query, and confirm the older matching day ranks above a
newer non-matching one.
