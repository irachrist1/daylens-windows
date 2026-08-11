<!--lint disable no-undefined-references strong-marker-->

# Implementation Plan: WO-6

**Work Order:** WO-6 — [backend] Restore the unified search handler and filter contract
**Created At (UTC):** 2026-08-11T09:20:00Z

## Summary

`SearchOptions` carries date bounds, a limit, and two internal pagination
bounds. AC-SM-002.1 requires eight filter kinds, seven of which have nowhere to
live. This widens that contract, enforces it inside every exact reader, adds the
unified IPC channel over WO-7's planner, and gives the AI context path the same
options object so the person-facing query and the AI's query cannot diverge.

The work order's title says "restore". Nothing needs restoring — the handler
module exists and is registered. What is added is the *unified* channel, which
never existed: today's eight channels each return one path's raw rows.

## Code Reuse And Package Structure

Reused:

- `src/main/services/retrievalPlanner.ts` — `planRetrieval`, delivered by WO-7.
  The unified channel is a thin wrapper over it. The planner already applies
  whatever `SearchOptions` it is handed to every path it runs, so widening the
  type is the only change it needs.
- `searchBounds` in `queries.ts` — the existing date/limit normalizer. The new
  filter SQL is built alongside it, not inside it, so the date path is untouched.

Modified:

- `src/main/db/queries.ts` — `SearchFilters` added and `SearchOptions` extended;
  filter SQL applied in `searchSessions`, `searchBlocks`, `searchBrowser`,
  `searchArtifacts`, `searchEntityMoments`, `searchSemanticMoments`.
- `src/main/ipc/search.handlers.ts` — the `search:unified` channel.
- `src/preload/index.ts` — `search.unified` on the bridge.
- `src/main/services/contextPacket.ts` — its `scope` widens from
  `{ startDate?, endDate? }` to `SearchOptions`, so AI context inherits filters.

Created:

- `tests/searchFilters.test.ts`.

## Components And Flow

### The contract

```ts
export interface SearchFilters {
  applications?: string[]   // bundle id or app name
  websites?: string[]       // domain
  projects?: string[]       // entity id
  clients?: string[]        // entity id
  people?: string[]         // entity id
  meetings?: string[]       // entity id
  sources?: SearchSourceType[]
}
export interface SearchOptions extends SearchFilters { /* existing date/limit fields */ }
```

Project, client, person, and meeting are all entity ids in one table. They are
kept as four named fields rather than one `entityIds` because the requirement
names them separately and a caller should not have to know they share a
namespace. They funnel into one id set at the SQL boundary.

### Eligibility — the rule that makes the filters safe

Not every reader can express every filter: `ai_artifacts` has no domain,
`website_visits` has no project. The rule is that **a reader which cannot
express a set filter returns nothing rather than returning unfiltered rows.**

This is the only safe direction. The alternative — letting a reader ignore a
filter it cannot express — means applying a website filter still returns
sessions and artifacts, so the filter silently fails to constrain the result
set. An omission is visible and recoverable; a leak is neither. The same
conservative instinct already exists in `contextPacket.ts`, where an id
collision drops a row rather than risking the wrong one.

Expressible filters per reader:

| Reader | applications | websites | entity filters | sources |
| --- | --- | --- | --- | --- |
| `searchSessions` memory arm | yes (`app_bundle_id`/`app_name`) | no | yes (`memory_record_entities`) | yes (`memory_type`) |
| `searchSessions` legacy arm | yes (`bundle_id`/`app_name`) | no | no | observed only |
| `searchEntityMoments` | yes | no | yes | yes |
| `searchSemanticMoments` | yes | no | yes | yes |
| `searchBrowser` | yes (`browser_bundle_id`) | yes (`domain`) | no | observed only |
| `searchBlocks` | no | no | no | observed only |
| `searchArtifacts` | no | no | no | observed only |

"observed only" means the reader is eligible under a `sources` filter only when
that filter includes `observed`, because every row it can return is direct
capture.

AC-SM-002.2 falls out of this: with no filter set, nothing is ineligible and
every reader runs unbounded, exactly as today.

### The unified channel

`search:unified` takes `{ query, opts }` and returns `planRetrieval`'s
`RetrievalResponse` — plan, ranked results, and the degraded flag. The eight
existing channels stay, unchanged: the palette migrates to the unified channel
in WO-13, and removing the others before then would break the live surface.

### AI context

`BuildContextPacketInput` gains `filters?: SearchOptions`. `exactSearchItems`
and `semanticSearchItems` take the whole options object instead of a date pair.
AC-SM-002.3 then holds structurally — both sides read the same field — rather
than by two call sites agreeing to pass the same thing.

## Steps

1. `SearchFilters` and the widened `SearchOptions`.
2. `searchFilterSql(opts, dialect)` — one builder emitting the WHERE fragment and
   params for a given reader's column names, plus `readerIneligible(opts, can)`.
3. Apply to the memory-record readers (`searchSessions` memory arm,
   `searchEntityMoments`, `searchSemanticMoments`).
4. Apply to the legacy arm, `searchBrowser`, `searchBlocks`, `searchArtifacts`.
5. `search:unified` handler and the preload bridge entry.
6. Widen `contextPacket`'s scope to `SearchOptions`.

## Testing

`tests/searchFilters.test.ts`, against a database built from `SCHEMA_SQL`:

- an application filter restricts sessions and eliminates artifacts
  (AC-SM-002.1);
- a website filter restricts the browser reader and returns nothing from the
  session, block, and artifact readers — the leak case;
- a client filter restricts to that entity's tagged records, alias-resolved;
- a source filter of `['supplied']` returns confirmed facts and no observed
  capture;
- combining a date and an application filter intersects rather than unions;
- no filters returns the same rows as today (AC-SM-002.2), asserted against an
  unfiltered call on the same fixture;
- the unified channel's options reach every path: a filtered `planRetrieval`
  returns only in-scope results;
- `buildContextPacket` given filters produces only in-scope items
  (AC-SM-002.3).

Commands:

```bash
npm run typecheck && npm run lint
node scripts/run-tests.mjs searchFilters retrievalPlanner retrievalRanking \
  exactSearch naturalSearch semanticSearch search contextPacket memoryV2
```

The existing suites run alongside because `queries.ts` is shared by every search
consumer: the no-filter path must be provably unchanged.
