# Performance review: Snow Leopard pass (2026-06-22)

Imported from a Factory mission (`mis_05998336`, "Daylens Snow Leopard: Make
Everything Instant") that ran on 2026-06-22 against the real database and then
paused. Its analysis existed nowhere in this repository until 2026-08-11.

**What the mission produced.** Four parallel investigations against the real
database, a thirteen-entry root-cause register with file locations and `EXPLAIN`
evidence, sixty named validation assertions, and a captured baseline: `EXPLAIN
QUERY PLAN` for sixteen hot queries, PRAGMA state, `knip` and `depcheck` output,
and a 507MB database backup.

**What it shipped.** Nothing. It completed one feature (`m1-baseline-and-backup`)
with a `partial` result, its validators did not pass, and it paused. All sixty
assertions are still unverified. No code from this mission reached the repository.

**Why it is kept.** The root causes were measured rather than guessed, and most
are still present. The measurements are stale — the database has grown from 507MB
to roughly 1.2GB and the suite from 672 tests to 2197 — but the causes and their
locations survive. Re-measure before acting on any number here.

## The bar

Set by the owner, and the reason the mission existed. Reported symptoms: opening
Apps freezes; Apps to Timeline freezes hard, sometimes requiring force-quit;
stepping to the previous week locks for several seconds.

- Every interaction renders in about 100ms where data is light or cached.
- Nothing blocks the UI thread for more than about 200ms. This is the firm gate.
- No multi-second freezes, no beachball, no force-quit. The laptop stays
  responsive.

## Root causes

Status checked against the working tree on 2026-08-11. Line numbers from the
original register are omitted where they have shifted; every file still exists.

| # | Location | Cause | Status 2026-08-11 |
| --- | --- | --- | --- |
| R1 | `src/main/services/database.ts` | `ANALYZE` has never run, so no `sqlite_stat1` exists and the planner mis-picks indexes | **Open, verified.** `sqlite_stat1` is still absent from the live database. The mission measured the hottest query at 130ms falling to 3ms after `ANALYZE` |
| R2 | `src/main/services/database.ts` | PRAGMAs untuned: cache ~8MB, `mmap_size` 0, `temp_store` on disk | **Mostly closed.** `cache_size = -65536` (64MB), `mmap_size = 536870912` (512MB), and `busy_timeout = 5000` are now set. `temp_store = MEMORY` is still not |
| R3 | `src/main/services/workMemory.ts` | `gatherConcurrentEvidence` predicate is non-sargable (`visit_time + duration > ?`), scanning ~45K `website_visits` rows per block | Unverified. `EXPLAIN` showed a search on `visit_time<?` only, post-filtering 45,069 of 45,070 rows, at 14-20ms per call times blocks times seven in week view |
| R4 | `src/main/services/workBlocks.ts` | `buildBlockFromCandidate` N+1: 5-6 range queries per block, ignoring the already-loaded `TimelineBuildContext` | Possibly closed. The function now takes a `context` parameter; whether it still issues per-block queries is unverified |
| R5 | `src/main/services/workBlocks.ts` | `buildWindowTitleEvidence` picks the wrong index on `focus_events` without statistics | Open, follows R1. 5.7ms per call scanning versus 0.1ms with the right index; ~130ms per day |
| R6 | `src/main/services/workBlocks.ts` | "Today" never returns persisted blocks: full recompute and persist on every open and every 30s tick | Unverified |
| R7 | `src/renderer/views/Timeline.tsx` | Week view fires seven `getTimelineDay` calls for full payloads just to draw category bars, and re-runs on every step | Likely open. No week-summary handler exists in `src/main` |
| R8 | `src/main/services/workBlocks.ts` | `getAppDetailPayload` calls `getAppSummariesForRange` twice | Unverified |
| R9 | `src/renderer/App.tsx`, `src/renderer/hooks/useProjectionResource.ts` | Tab switch unmounts the view and cold-refetches; no cross-tab cache | Unverified |
| R10 | `src/renderer/components/AppIcon.tsx`, `useResolvedIcon.ts`, `db.handlers.ts` | One `icons:resolve` IPC per app row on first paint, with main-thread file reads | Unverified |
| R11 | `src/main/services/distractionAlerter.ts` | Distraction check runs on every 5s tracking tick and on a 60s timer | Unverified. Note DEV-289: the distraction alerter is spec-removed but fully live, so this may be deleted rather than fixed |
| R12 | `src/main/services/tracking.ts` | `flushPendingAttributionRefresh` runs attribution refresh and projection rebuilds synchronously on main | Unverified |
| R13 | `src/main/db/queries.ts` | Function-wrapped date `GROUP BY`s are non-sargable; `getAllAppsForLabeling` uses a correlated `MAX(id)` subquery | Unverified. All four symbols still present |

The structural finding behind all of them: `better-sqlite3` runs synchronously on
the Electron main process, so every IPC handler runs its query inline and any slow
query parks the event loop. That is the force-quit symptom. The AI tab is fast
because it streams off-main.

## What the mission proposed

Measure first, cheapest leverage first, re-measure after each milestone.

1. **DB foundation** — `ANALYZE` and `PRAGMA optimize` on init, tuned PRAGMAs,
   missing indexes, a sargable `gatherConcurrentEvidence` predicate, rewritten
   date `GROUP BY`s, the N+1 routed through the day context.
2. **View responsiveness** — stop recomputing today on open and on every tick, one
   lightweight week-summary query instead of seven payloads, batched icon
   resolution, cross-tab caching.
3. **Background work** — coalesce the distraction check, defer attribution and
   projection rebuilds off the interaction path, WAL checkpoint hygiene.
4. **Cleanup** — remove dead code confirmed by `knip` and a manual trace; triage
   `depcheck`.

Moving the database off the main process via Electron `utilityProcess` was held as
a gated contingency, to be triggered only if re-measurement still breached the
200ms ceiling, because it is the one change that touches the capture and evidence
seam.

## Boundaries the mission honored

Worth preserving in any successor work: the capture and evidence core —
segmentation, the evidence object, resolvers, the privacy boundary, projection
determinism — is correct and stays correct. It gets faster; it does not get
redesigned. A fix that genuinely requires reworking that core stops and surfaces
the reasoning instead of quietly changing it. Derived output must stay identical:
a content difference is a failure even when the timings pass.

## Relationship to tracked work

- DEV-259 (Make development and runtime startup fast again, In Progress) overlaps
  R6, R9, and startup.
- DEV-227 (The app freezes on long date ranges, Done) covers part of R7 and the
  all-time scope assertions.
- DEV-261 (main-thread stall watchdog, In Review) instruments the symptom this
  review diagnoses.
- DEV-289 (focus score and distraction alerter are spec-removed but fully live)
  determines whether R11 is fixed or deleted.
- `docs/TO-DO.md` carries the `knip`/`depcheck` item that was milestone 4.

R1 is untracked, verified open, and the cheapest item in the register.

## The assertions

The sixty validation assertions are the durable part and live in
[`docs/acceptance/performance.md`](../acceptance/performance.md) as acceptance
lines, keeping their original identifiers.
