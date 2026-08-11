<!--lint disable no-undefined-references strong-marker-->

# Implementation Plan: WO-12

**Work Order:** WO-12 — [data] Make canonical memory records the only exact-search boundary
**Created At (UTC):** 2026-08-11T10:10:00Z

## Summary

Exact retrieval has one canonical arm and three source-specific ones. Sessions
read `memory_records` and fall back to raw capture only for unindexed days.
Browser pages, artifacts, and timeline blocks read their source tables directly,
each re-implementing the correction checks by hand — and `searchArtifacts`
re-implements none of them, so an artifact inside an ignored block span is still
returned.

This gives browser pages a canonical record kind and converts the browser and
artifact readers to the same two-arm shape sessions already use, so a correction,
exclusion, or deletion propagates through one boundary instead of three
hand-copied approximations.

## Code Reuse And Package Structure

Reused:

- `ensureMemorySearchSchema` in `migrations.ts` — already written for the
  `memory_records`-rebuild path: it drops the FTS vtable and its content view in
  the right order, recreates them and their four triggers, and reindexes.
  The v70 rebuild calls it rather than hand-rolling FTS repair.
- The v50 `projects` rebuild in `migrations.ts` — the established FK-safe
  pattern in this repository: back up child rows, clear them, drop the parent,
  rename, restore. `memory_record_entities` and `memory_record_vectors` both
  cascade from `memory_records`, so v70 follows it.
- `getCorrectedDomainIntervals` in `activityFacts.ts` — corrected browser
  intervals with site exclusions already applied. Page records project from it
  rather than from raw `website_visits`, which is what makes the canonical arm
  correct by construction.
- The two-arm reader shape in `searchSessions` — copied in structure, not in
  code, for the browser and artifact readers.

Modified:

- `src/main/db/migrations.ts` — v70.
- `src/main/services/memoryIndex.ts` — the `page` kind, `pageRecords`, the
  fingerprint input for `website_visits`, `MEMORY_INDEX_VERSION` to 3.
- `src/main/db/queries.ts` — `searchBrowser` and `searchArtifacts` gain canonical
  arms.

Created:

- `tests/canonicalExactBoundary.test.ts`.

## Components And Flow

### v70 — the schema move

`memory_records.record_kind` is constrained by a CHECK that has no page value,
and SQLite cannot alter a CHECK in place. The table is rebuilt, which is also
the cheapest moment to add the two columns a page record needs:

```
domain TEXT   -- the site a page record is about
url    TEXT   -- the specific page, when known
```

Order, following the v50 precedent because the production pragma is
`foreign_keys = ON` and both child tables cascade:

1. back up `memory_record_entities` and `memory_record_vectors`;
2. clear both, so `DROP TABLE memory_records` raises no FK violation;
3. create `memory_records_v70` with the widened CHECK and the two columns;
4. copy every row, `supplied_fact` rows included — those exist by explicit
   confirmation, are not part of any day projection, and would be lost forever
   if the rebuild dropped them;
5. drop, rename, recreate the two indexes;
6. restore both child tables;
7. call `ensureMemorySearchSchema` to rebuild the FTS index over the new rowids.

Step 4 is the one that has to be right. Everything else is re-derivable by a
re-projection; a dropped supplied fact is not.

### Page records

`pageRecords(db, date, fromMs, toMs)` builds one record per domain per day from
`getCorrectedDomainIntervals`, spanning the domain's first to last corrected
interval, with the most-visited page title as the record title. Grouping by
domain rather than by visit keeps the record count proportional to sites visited
rather than to raw history size, and matches how a person recalls browsing
("that Notion page", not one of 40 visit rows).

`exact_text` is the domain plus the titles seen on it, so a title search still
lands. Where an entity exists for the page, the record is entity-named and
`exact_text` stays empty, matching how `artifactRecords` already works — that is
what makes a rename apply without a reindex.

`MEMORY_INDEX_VERSION` goes to 3 so every already-indexed day re-projects and
picks up its page records; the fingerprint gains a `website_visits` term so
later browsing re-triggers a day.

### The two-arm readers

`searchBrowser` and `searchArtifacts` take the shape `searchSessions` has:

- canonical arm over `memory_records` filtered to the relevant `record_kind`,
  carrying `MEMORY_RECORD_CORRECTION_FILTERS` and the WO-6 filter SQL;
- legacy arm over the source table, gated on
  `NOT EXISTS (SELECT 1 FROM memory_index_days WHERE date = <row's local day>)`,
  so an indexed day answers exactly once and an unindexed day still answers
  (AC-SM-006.3);
- both merged by recency and sliced to the limit.

`searchArtifacts`'s legacy arm additionally gains the ignored-span check it has
always been missing, because until every historical day is indexed that arm is
still answering — closing the hole only on the canonical side would leave it open
for exactly the days that have not been backfilled yet.

### What is deliberately not moved

`searchBlocks` keeps reading `timeline_blocks`. A timeline block is the
*presentation* of a span of corrected activity whose underlying facts are
already canonical as `session` records; projecting blocks too would put every
moment into `memory_records` twice and make reconciliation fight itself. Its
existing filters already exclude invalidated and ignored blocks. Recorded as a
limit with this reasoning rather than silently skipped.

## Steps

1. v70: the rebuild, following the v50 FK-safe pattern.
2. `memoryIndex`: `page` in `MemoryRecordKind`, `pageRecords`, the fingerprint
   term, `MEMORY_INDEX_VERSION` to 3, and the insert carrying `domain`/`url`.
3. `searchBrowser`: canonical arm plus gated legacy arm.
4. `searchArtifacts`: canonical arm plus gated legacy arm, and the missing
   ignored-span filter on the legacy arm.
5. Tests.

## Testing

`tests/canonicalExactBoundary.test.ts`:

- a day's browsing projects into `page` records carrying domain, url, title,
  provenance, memory type, sensitivity, source refs, and time range
  (AC-SM-005.1, AC-SM-005.4);
- an excluded site does not produce a page record, and does not return from
  exact search after the day re-projects (AC-SM-006.2);
- **an artifact inside an ignored block span does not return** — the defect this
  work order exists to close, asserted on both arms (AC-SM-006.2);
- an indexed day returns each page and artifact exactly once, with no legacy
  double-count (AC-SM-006.3);
- an unindexed day still answers from the legacy arm (AC-SM-006.3);
- a supplied fact survives the v70 rebuild and a subsequent day re-projection;
- the WO-6 filters still apply to both new canonical arms.

Commands:

```bash
npm run typecheck && npm run lint
node scripts/run-tests.mjs canonicalExactBoundary searchFilters retrievalPlanner \
  exactSearch semanticSearch search memoryV2 memoryBackfill suppliedMemory \
  upgradedDatabaseMigration
```

`upgradedDatabaseMigration` is included because v70 rebuilds a table on the
upgrade path; `suppliedMemory` because the rebuild must not lose a confirmed
fact.
