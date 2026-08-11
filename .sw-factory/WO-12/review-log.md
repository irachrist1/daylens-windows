<!--lint disable strong-marker-->

# Review Log: WO-12

**Work Order:** WO-12 — [data] Make canonical memory records the only exact-search boundary
**Initialized At (UTC):** 2026-08-11T10:05:00Z

This file records review and verification rounds. Append new rounds; do not overwrite prior rounds.

---

## Round 1 — verification of the implementation in this worktree

**Verdict: APPROVED with two recorded limits.** The defect this work order
targets — exact retrieval returning corrected, excluded, or deleted history — is
closed for browsing and for artifacts. Two readers are deliberately not moved to
the canonical boundary, each for a reason stated below rather than skipped.

**Method.** Self-review by code reading against the acceptance criteria, a new
test file, and a full-suite regression run. Three defects in my own work were
caught by tests and fixed before this round; they are recorded because two of
them were nearly shipped.

### Acceptance criteria

| Criterion | Verdict | Evidence |
| --- | --- | --- |
| AC-SM-005.1 one canonical record per retrievable activity fact or confirmed supplied memory | Met for browsing, which had none | `pageRecords` projects one `page` record per domain per day. Test: three visits across two domains produce two records. |
| AC-SM-005.4 inspectable provenance, memory type, sensitivity, source evidence, effective time range | Met | Each page record carries `memory_type=observed`, `provenance=corrected_domain`, `sensitivity`, `source_refs_json`, `title`, `url`, and a `start_ms`/`end_ms` spanning its visits. Asserted field by field. |
| AC-SM-006.1 exact retrieval through the canonical boundary | Met for browsing; recorded limits for two readers | `searchBrowser` reads `memory_records` where `record_kind='page'` first. `searchSessions` excludes page records so a domain is not reported twice. Limits L1 and L2 below. |
| AC-SM-006.2 a deleted, excluded, or ineligible record cannot return through every exact path | Met | An excluded site leaves no record and stops returning after re-projection; a visit inside an ignored span never becomes a record; **an artifact inside an ignored span no longer returns** — the headline defect. |
| AC-SM-006.3 retrieval stays correct while a historical day is indexed | Met | `searchBrowser`'s legacy arm is gated on `NOT EXISTS (… memory_index_days …)`. Tested both ways: an unindexed day answers from the legacy arm, an indexed day answers exactly once. |

### The defect that is now closed

`searchArtifacts` applied no correction, exclusion, or deletion filter of any
kind. Every other exact reader carried at least a hand-rolled version; that one
carried none, so an artifact created inside a span the person had marked ignored
was still returned by search. It now carries the ignored-span check, and the
test asserts the before-and-after directly: two artifacts findable, mark a span
ignored, one survives.

### Three defects in my own work, caught by tests

Recorded because two of them would have shipped a regression.

**1. Page records were projected from `getCorrectedDomainIntervals`.** That
helper clips page time against the browser's corrected foreground ownership,
which is correct for *time credit* and wrong for *retrieval*: a page visited
while the browser was never the foreground app produced no interval, so no
record, so it became unfindable. Retrieval asks "did I see this", not "how long
does this get credited". `pageRecords` now projects from visits and subtracts
the ignored spans and site exclusions itself.

**2. `searchArtifacts` was pointed at the wrong canonical records.** The
canonical `artifact` record kind projects `artifacts` / `artifact_mentions` —
documents observed in window titles. `searchArtifacts` searches `ai_artifacts` —
files the assistant produced in a thread. They are different tables and
different things. Routing the reader at the canonical arm and gating its legacy
arm made every AI artifact unfindable on any indexed day. Reverted; the reader
keeps its own table and gains only the correction filter it was missing. This is
L1 below.

**3. Page records surfaced through two readers at once.** `searchSessions`'s
memory arm has no `record_kind` filter, so it returned the new page records as
session-shaped rows alongside `searchBrowser`'s browser-shaped ones — one domain
reported twice for one query, and not reconcilable by the planner because the
two shapes carry different subjects. `searchSessions` now excludes
`record_kind='page'`.

A fourth issue was caught by the first test run of the migration: `DROP TABLE
memory_records` while `memory_records_fts_content` still selected from it left a
view pointing at a missing table, which broke every later statement touching the
FTS vtable. The vtable and view are now dropped before the rebuild and recreated
by `ensureMemorySearchSchema` after.

### Recorded limits

**L1 — `ai_artifacts` has no canonical projection.** Exact retrieval over
AI-produced artifacts still reads `ai_artifacts` directly. Giving it a canonical
boundary means projecting `ai_artifacts` into `memory_records` under a new record
kind, which is a schema and projection change beyond this work order's In Scope
and would need its own migration. The correctness hole that mattered — no
correction filter at all — is closed on the reader as it stands. AC-SM-006.1 is
therefore met for the paths this work order moved and not universally true; that
distinction is deliberate and should not be checked off as complete.

**L2 — `searchBlocks` is deliberately not moved.** A timeline block is the
presentation of a span of corrected activity whose underlying facts are already
canonical as `session` records. Projecting blocks as well would put every moment
into `memory_records` twice and make the planner's reconciliation fight itself.
Its existing filters already exclude invalidated blocks, ignored blocks, and
blocks superseded by a text correction. Not a gap so much as a design position,
recorded so a later reader does not mistake it for an oversight.

### Blueprint alignment

**Accurate.** "#MemoryIndex projects a day's corrected activity facts into
`memory_records`… The current fallback and deletion paths still leave two
retrieval states that must be consolidated under the canonical boundary."
Confirmed and partly closed: browsing is consolidated, `ai_artifacts` is not
(L1).

**Accurate, and out of scope here.** "#TrackingHistory and #ConnectorPurge
currently do not call #MemoryIndex after their deletion work." Verified still
true. That is deletion-orchestration work this work order's Out of Scope
excludes; it is a real remaining hole in AC-SM-006.2 for the *deletion* path
specifically, and is called out under cross-lane dependencies.

The Factory documents were not edited.

### Cross-lane dependency

`src/main/services/trackingHistory.ts` and the connector-purge path do not
refresh the memory index after deleting raw history or connected records. Until
they do, deleted underlying data can still be represented by a canonical record
until that day happens to re-project. Both files are outside this work order's
scope and were not edited. This is the remaining half of AC-SM-006.2 and needs
an owner.

### Migration

v70 only, from the 70–74 range allocated to this session. It follows the v50
`projects` precedent for an FK-safe rebuild: back up `memory_record_entities` and
`memory_record_vectors`, clear them so `DROP TABLE` raises no violation under
`foreign_keys = ON`, rebuild, restore. Supplied-fact rows are copied through
explicitly — they exist by confirmation, are not part of any day projection, and
nothing would ever recreate them. A test asserts a confirmed fact and its
retrieval mirror both survive.

`MEMORY_INDEX_VERSION` goes to 3, and the day fingerprint gains a
`website_visits` term, so already-indexed days re-project and pick up their page
records rather than silently staying page-less.

### Tests

`tests/canonicalExactBoundary.test.ts` (11 pass). Regression: `searchFilters`,
`retrievalPlanner`, `retrievalRanking`, `exactSearch`, `semanticSearch`,
`search`, `searchResults`, `memoryV2`, `memoryBackfill` all green.
`npm run typecheck` clean; `npx eslint` clean on all four changed files. Full
suite result recorded in the wave summary.

### Exploratory pass

Not performed against the live database. The migration rebuilds a table holding
real personal history, and this session's instruction keeps verification against
real data out of commits; the hermetic fixtures cover the rebuild path including
the supplied-fact survival case. The manual check owed before release: open the
palette on a machine with existing history, confirm a previously-visited domain
is still findable after the v70 upgrade and the day re-projects.
