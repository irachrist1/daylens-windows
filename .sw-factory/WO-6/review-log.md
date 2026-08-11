<!--lint disable strong-marker-->

# Review Log: WO-6

**Work Order:** WO-6 — [backend] Restore the unified search handler and filter contract
**Initialized At (UTC):** 2026-08-11T09:15:00Z

This file records review and verification rounds. Append new rounds; do not overwrite prior rounds.

---

## Round 1 — verification of the implementation in this worktree

**Verdict: APPROVED with one recorded gap.** All three acceptance criteria of
REQ-SM-002 are met and covered by tests. The gap is that no surface lets a person
*set* a filter yet; the contract is enforced end to end but is currently only
reachable programmatically.

**Method.** Self-review by code reading against the acceptance criteria, a new
test file built around the leak case, and a regression run of every search and
context-packet suite. No review subagent was spawned — this session was directed
to execute its work orders directly.

### Acceptance criteria

| Criterion | Verdict | Evidence |
| --- | --- | --- |
| AC-SM-002.1 a date, application, website, project, client, person, meeting, or source filter restricts all eligible retrieval paths | Met | `SearchFilters` carries all seven missing kinds; `memoryRecordFilterSql`, `appSessionFilterSql`, and `websiteVisitFilterSql` apply them inside `searchSessions` (both arms), `searchEntityMoments`, `searchSemanticMoments`, and `searchBrowser`; `readerIneligible` eliminates readers that cannot express a set filter. Nine tests in `tests/searchFilters.test.ts`, including the planner-level check that the scope reaches every path. |
| AC-SM-002.2 no filter means the full eligible local history | Met | `readerIneligible` returns false when nothing is set and every filter builder emits an empty fragment, so the unfiltered SQL is byte-identical to before. Asserted directly: with no filters, all four readers answer and the planner returns more than one source type. |
| AC-SM-002.3 AI context uses the same text and filters as the person-facing query | Met | `BuildContextPacketInput.filters` is a `SearchOptions`, and `exactSearchItems` / `semanticSearchItems` now take the whole options object rather than a date pair. Both sides read one field, so the two queries cannot drift. |

### The design decision worth defending

**A reader that cannot express a set filter returns nothing.** `ai_artifacts` has
no domain column; `website_visits` has no project. The alternative — letting such
a reader ignore the filter and return its rows — means narrowing a search to
`notion.so` still brings back sessions and artifacts, so the filter fails to
constrain the result set while appearing to work.

That is a silent correctness failure in the exact place this wave exists to make
trustworthy: if retrieval returns the wrong evidence, every answer above it is
wrong. An omission is visible to the person and recoverable by widening the
filter; a leak is neither. `tests/searchFilters.test.ts` has two tests written
specifically for the leak case, asserting the union query returns only rows from
the one reader that could express the filter.

### One recorded gap

**No surface sets filters yet.** The command palette sends `{ limit: 24 }` and
has no filter controls. This work order's In Scope is the request path, the
options contract, and enforcement at the handler boundary — all delivered — and
the palette filter UI is in neither this work order nor WO-13, which covers
result rendering. So AC-SM-002.1 is met as a contract and enforced in the
readers, but the phrase "when the person applies a filter" has no user gesture
behind it today. Stated rather than checked off silently; it is work someone has
to schedule.

### Blueprint alignment

**The work order's premise and the blueprint's claim are both false.** The work
order is titled "Restore the unified search handler"; the blueprint says twice
that the main-process registration for this boundary is "absent from the
connected repository". `src/main/ipc/search.handlers.ts` exists, registers all
eight documented channels, and is wired at `src/main/index.ts:109` and `:1347`.

Built against the code: nothing was restored. What was genuinely missing is the
*unified* channel — the eight existing ones each return one path's raw rows and
none returns a reconciled, ranked set — so `search:unified` was added over WO-7's
`planRetrieval` and the eight were left registered, because live surfaces still
call them and removing them before WO-13 migrates the palette would break search.

**Accurate:** "Current `SearchOptions` supports only date bounds, limit, and
internal pagination bounds; application, website, project, client, person,
meeting, and source scopes must be added to meet the feature contract." Confirmed
and now closed.

The Factory documents were not edited.

### Cross-lane note

`src/main/db/queries.ts` was edited. It is not on this session's do-not-touch
list, and `SearchOptions` plus every exact reader live in it, so the filter
contract could not be delivered without it. Edits are confined to the
`SearchOptions` declaration, the new filter helpers, and the six search
functions; no other query in the file was touched. Flagging it because the file
is broadly shared and a concurrent lane editing the same search functions would
collide.

### Tests

`tests/searchFilters.test.ts` (12 pass). Regression: `retrievalPlanner`,
`retrievalRanking`, `exactSearch`, `naturalSearch`, `semanticSearch`, `search`,
`searchResults`, `memoryV2`, `memoryBackfill`, `contextPacket`,
`contextPacketInspection`, `contextPacketGranolaGate` — 115 pass, 0 fail across
13 files. `npm run typecheck` clean; `npx eslint` clean on all five changed
files.

### Exploratory pass

Not performed, for the same reason as the recorded gap: there is no user gesture
that sets a filter, so there is nothing to exercise by hand beyond what the tests
cover. The check to run once a filter UI exists: narrow the palette to one
website and confirm no session or artifact rows survive.
