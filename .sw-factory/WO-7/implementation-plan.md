<!--lint disable no-undefined-references strong-marker-->

# Implementation Plan: WO-7

**Work Order:** WO-7 — [backend] Build the unified retrieval planner and ranker
**Created At (UTC):** 2026-08-11T08:40:00Z

## Summary

Daylens has three retrieval paths and no planner. Exact retrieval works and is
alias-aware; semantic retrieval works and is silent about its own availability;
structured retrieval has aggregates but no search caller. Nothing above them
decides which to run, nothing reconciles their overlapping output, and ordering
is `startTime DESC` everywhere — so a newer non-matching row always beats an
older exact match, which AC-SM-003.3 forbids outright.

This adds one main-process module, `src/main/services/retrievalPlanner.ts`, that
sits above the existing paths and below the IPC boundary. It resolves scope,
selects paths, runs them, reconciles duplicate representations of the same
activity, and ranks the survivors on the nine factors AC-SM-003.2 names. It
composes the existing readers rather than replacing them: `searchExact`,
`searchByMeaning`, and the `activityFacts` aggregates all keep their current
callers and behavior.

## Code Reuse And Package Structure

Reused rather than rebuilt:

- `src/main/services/exactSearch.ts` — `searchExact` and
  `resolveQueryEntityMatches`. Entity resolution is already alias- and
  merge-aware and already runs at query time; the planner lifts it to a
  pre-retrieval step instead of reimplementing it. This is what closes
  AC-SM-001.2 at the planner level.
- `src/main/services/semanticIndex.ts` — `searchByMeaning`. Extended, not
  replaced (see below).
- `src/main/services/searchTerms.ts` — `isLiteralQuery` becomes the semantic
  eligibility gate for AC-SM-001.5, and `deterministicTerms` supplies the
  lexical-match signal.
- `src/main/services/activityFacts.ts` — `getCorrectedAppSummariesForRange` and
  `getCorrectedWebsiteSummariesForRange` are the structured retrieval source for
  AC-SM-001.3. Read-only use; that module is not edited.
- `src/main/lib/localDate.ts` — `localDateString`, `shiftLocalDateString`,
  `daysFromTodayLocalDateString` for time-range resolution.

Created:

- `src/main/services/retrievalPlanner.ts` — the planner and the response
  contract.
- `src/main/services/retrievalRanking.ts` — the pure scoring core: signal
  extraction, the tier rule, and the weighted sum. Split out so it is testable
  with no database and so AC-SM-003.4 can be asserted against a closed signal
  type rather than against prose.
- `tests/retrievalPlanner.test.ts`, `tests/retrievalRanking.test.ts`.

Modified:

- `src/main/services/semanticIndex.ts` — one added export,
  `searchByMeaningWithStatus`, returning `{ results, available, reason }`.
  `searchByMeaning` keeps its exact current signature and behavior and is
  reimplemented as a thin wrapper over the new function, so no existing caller
  changes. Needed because today unavailability and "ran, found nothing" are both
  `[]`, and AC-SM-001.6 requires the planner to distinguish them.

## Components And Flow

`planRetrieval(db, query)` runs four ordered stages. The order is the
requirement: AC-SM-001.1 and .2 both say "before retrieval begins."

**1. Scope resolution.** `resolveRetrievalScope` produces a `RetrievalScope`
before any reader is touched.

- Time. An explicit `startDate`/`endDate` filter wins. Failing that, the query
  text is parsed for a requested range — `today`, `yesterday`, `last week`,
  `this week`, `last month`, `this month`, `last N days`, an ISO `2026-08-01`,
  and a bare month name. The scope records `timeRangeSource` so a filter range
  and a text range are distinguishable downstream.
- Entities. `resolveQueryEntityMatches` resolves the text against canonical
  names and aliases, merge-aware. When more than one survivor comes back at the
  same rank, the scope is marked `ambiguousEntity` and carries every candidate.
  The planner never silently picks one — that is the main-process half of what
  WO-13's AC-SM-004.3 renders.

**2. Path selection.** `selectRetrievalPaths` returns the eligible set and, for
each ineligible path, a reason.

- Exact is included whenever the query has any searchable token (AC-SM-001.4).
  Quoted phrases, URLs, filenames, and names all reduce to this.
- Structured is included when the query asks for a count, a duration, or a
  relationship — `how much`, `how many`, `how long`, `total`, `hours`, `time
  spent`, `count` — or when the scope resolved a time range with no lexical
  content to match (AC-SM-001.3).
- Semantic is included when the query is not a short literal (`isLiteralQuery`)
  and the local model, extension, and vector table are all present
  (AC-SM-001.5). When it is eligible but unavailable, it is recorded in
  `plan.unavailable` and the response is marked `degraded` — the query still
  succeeds on the other paths (AC-SM-001.6).

**3. Retrieval.** Each selected path runs inside the resolved scope. Semantic
receives the scope's date bounds, which is the part AC-SM-001.5 currently
misses. Every path is wrapped so a thrown error degrades that path rather than
failing the query.

**4. Reconciliation and ranking.**

`reconcileResults` groups raw rows by an identity key derived from the activity,
not from the row:

| Row shape | Key |
| --- | --- |
| entity result | `entity:<survivor id>` — already merge-resolved |
| moment | `moment:<startTime>:<normalized app, domain, or title>` |
| structured aggregate | `structured:<subject>` |

That key is what makes AC-SM-003.1 real: a `memory_records` projection and the
legacy `app_sessions` row for the same session share a start time and an app, so
they collapse into one result even though their `type` and `id` differ — which
the current `type:id:startTime` dedupe cannot do. The surviving representation
is the highest-quality one (canonical memory record over legacy row), the group
keeps every raw row under `representations`, and the paths that produced it
union into `foundBy`. `foundBy.length > 1` is the independent-corroboration
ranking signal.

`rankResults` scores each reconciled result. Signals, one per factor named in
AC-SM-003.2, all normalized to 0..1:

`exactLexical`, `semanticSimilarity`, `entityMatch`, `timeRangeFit`,
`sourceQuality`, `explicitCorrection`, `confirmedRelationship`,
`queryImpliedRecency`, `corroboration`.

The tier rule closes AC-SM-003.3. A result is in the **matched tier** when it
matches the requested date or a resolved entity exactly. Matched-tier results
sort above unmatched-tier results unconditionally; recency only ever orders
results inside a tier. A weighted sum alone would not satisfy the criterion,
because for any finite weight there is a recency gap large enough to overturn an
exact match — the criterion says that must never happen, so the guarantee is
structural rather than numeric.

`queryImpliedRecency` is only non-zero when the query actually implies recency
(`latest`, `recent`, `last`, or no time scope at all). A query naming a specific
date does not get a recency term at all.

AC-SM-003.4 is enforced by construction: `RankingSignals` is a closed type with
exactly those nine keys, the scorer destructures it, and a test asserts the key
set contains no productivity, focus, or behavioral term.

## Steps

1. **`retrievalRanking.ts`** — `RankingSignals`, `RANKING_WEIGHTS`,
   `scoreSignals`, `isMatchedTier`, `compareRanked`. No imports beyond types.
2. **Scope resolution** — `resolveRetrievalScope`, including the query-text time
   parser and the ambiguity flag.
3. **Path selection** — `selectRetrievalPaths` plus the structured-intent and
   semantic-eligibility predicates.
4. **Semantic availability** — add `searchByMeaningWithStatus` to
   `semanticIndex.ts`; rewrite `searchByMeaning` as its wrapper.
5. **Structured retrieval** — `runStructuredRetrieval`, reading the
   `activityFacts` aggregates within scope and emitting `structured` results.
6. **Reconciliation** — `reconcileResults` with the activity-identity key.
7. **Signal extraction** — `signalsFor(result, scope, query)`, the one place a
   raw row becomes the nine numbers.
8. **`planRetrieval`** — wire the stages, mark `degraded`, return
   `RetrievalResponse`.

Steps 1–3 and 6–7 are pure and land with unit tests before step 8 wires
anything.

## Testing

`tests/retrievalRanking.test.ts` — pure, no database:

- the signal key set is exactly the nine named factors, and contains no
  productivity, focus, or behavioral key (AC-SM-003.4);
- a matched-tier result outranks an unmatched-tier result that is newer by a
  day, a month, and a year (AC-SM-003.3, the structural claim);
- inside a tier, recency orders results;
- corroboration raises a result above an otherwise identical single-path result;
- every weight is positive and the score is bounded.

`tests/retrievalPlanner.test.ts` — against a temporary database built from
`SCHEMA_SQL`:

- a query with a date phrase resolves its range before retrieval, and the
  readers receive the resolved bounds (AC-SM-001.1);
- a query naming an alias resolves to the survivor entity before retrieval, and
  an ambiguous name yields multiple candidates with `ambiguousEntity` set
  (AC-SM-001.2);
- a `how long` query selects the structured path (AC-SM-001.3);
- a quoted phrase selects the exact path (AC-SM-001.4);
- a meaning-shaped query selects the semantic path and passes it the resolved
  date bounds (AC-SM-001.5);
- with the vector store absent, the plan records semantic as unavailable,
  `degraded` is true, and exact and structured results still return
  (AC-SM-001.6);
- the same session present as both a memory record and a legacy session row
  returns as one result carrying both representations (AC-SM-003.1);
- an older exact-date match ranks above a newer non-match end to end
  (AC-SM-003.3).

Commands:

```bash
npm run typecheck && npm run lint
node scripts/run-tests.mjs retrievalPlanner retrievalRanking exactSearch naturalSearch semanticSearch search
```

The existing search suites are run alongside because step 4 touches
`semanticIndex.ts`: `searchByMeaning`'s behavior must be provably unchanged for
its current callers.

## Out of scope, deliberately

IPC registration and the shared filter-schema change are WO-6. The planner takes
`SearchOptions` as it exists today and will pick up the extended filters when
WO-6 widens that type — it applies whatever it is handed to every path it runs,
so no planner change is needed then. Renderer presentation is WO-13. Canonical
record projection and vector maintenance are WO-12.
