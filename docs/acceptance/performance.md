# Acceptance: performance

Sixty acceptance lines for responsiveness, imported 2026-08-11 from the Factory
mission recorded in
[`docs/reviews/factory-snow-leopard-2026-06-22.md`](../reviews/factory-snow-leopard-2026-06-22.md).
Identifiers are kept from the original contract so evidence traces back.

`V2-SHIP-PRIORITIES.md` holds one performance line per surface ("load and
scrolling are smooth at every range, and Generate never freezes"). These are that
line, made checkable.

## The bar

Applies to every line below.

- Interaction renders in about **100ms** where data is light or cached.
- **Nothing blocks the UI thread longer than about 200ms.** Firm gate.
- No multi-second freeze, no beachball, no force-quit; the laptop stays
  responsive.
- **Correctness first.** Caching never serves permanently stale data, capture
  fidelity is preserved, and derived output is identical. A content difference
  fails the line even when every timing passes.

## State

Every line is `open`: none has been verified, and the original mission paused
before measuring any of them. One line, VAL-DB-002, is partially met — see the
note under DB foundation.

Grading these needs exclusive access to the real database: a single-instance lock
and single-writer SQLite mean the personal Daylens instance and the MCP server
must be quit first. Only one validator may run against that surface at a time.

## Apps view

| ID | Line |
| --- | --- |
| VAL-APPS-001 | Cold-open of Apps renders the app list without freezing |
| VAL-APPS-002 | App icons render on first paint without a per-row IPC stall |
| VAL-APPS-003 | Selecting an app renders the detail panel responsively |
| VAL-APPS-004 | Clicking a second app stays responsive — no degradation on repeat |
| VAL-APPS-005 | Switching scope to 30d does not freeze and shows correct rows |
| VAL-APPS-006 | Switching scope to All-time does not freeze the UI thread |
| VAL-APPS-007 | Opening an app detail at All-time scope stays responsive |
| VAL-APPS-008 | Scrolling a long app list stays smooth |
| VAL-APPS-009 | Switching scope with a different app selected stays correct and fast |
| VAL-APPS-010 | Day-by-day date navigation stays responsive |
| VAL-APPS-011 | Category filter chips re-filter without a stall |
| VAL-APPS-012 | Re-entering Apps after a tab switch does not pay full cold cost again |
| VAL-APPS-013 | AI narrative content for an app is unchanged by the performance pass |

## Timeline (day) view

| ID | Line |
| --- | --- |
| VAL-TIMELINE-001 | Today's initial render does not full-recompute or freeze |
| VAL-TIMELINE-002 | The 30s auto-refresh tick on today never causes a periodic freeze |
| VAL-TIMELINE-003 | Apps to Timeline stays interactive — no hard freeze |
| VAL-TIMELINE-004 | Navigating to a previous day and back stays responsive |
| VAL-TIMELINE-005 | Scrolling and interacting within a dense day stays smooth |
| VAL-TIMELINE-006 | Day timeline output is identical to baseline — no derived-output drift |
| VAL-TIMELINE-007 | Block corrections (merge, rename, boundary) stay responsive and re-project correctly |

## Week view and navigation

| ID | Line |
| --- | --- |
| VAL-WEEK-001 | Switching to Week view does not fetch seven full day payloads or lock up |
| VAL-WEEK-002 | Stepping to the previous week stays responsive — no multi-second lock |
| VAL-WEEK-003 | Stepping forward and repeated week navigation reuses cache |
| VAL-WEEK-004 | Week navigation keeps the laptop and other tabs responsive |
| VAL-WEEK-005 | Week category bars and totals match baseline — no derived-output drift |

## Cross-view switching and renderer caching

| ID | Line |
| --- | --- |
| VAL-NAV-001 | Repeated tab cycling stays responsive — no cold-refetch freeze |
| VAL-NAV-002 | Returning to an opened view reuses cached data, near-instant, no full re-query |
| VAL-NAV-003 | Cache stays correct — fresh data still appears via invalidation |
| VAL-NAV-004 | The AI tab remains fast — regression guard |
| VAL-NAV-005 | Icons appear without a per-row IPC stall on first paint |
| VAL-NAV-006 | Command palette open, search, and invoke stay responsive |
| VAL-NAV-007 | Settings interactions stay responsive and trigger correct re-projection |

## Startup

| ID | Line |
| --- | --- |
| VAL-STARTUP-001 | Cold launch reaches the first interactive view without a multi-second freeze |

## Background work and laptop-wide load

| ID | Line |
| --- | --- |
| VAL-BG-001 | Idle main-process CPU stays low — no constant churn |
| VAL-BG-002 | Background derived work causes no periodic UI stalls during interaction |
| VAL-BG-003 | Capture fidelity is preserved — new activity is still recorded |
| VAL-BG-004 | The laptop stays responsive under sustained use — bounded memory and CPU |
| VAL-BG-005 | Tray menu and global shortcuts respond during heavy work |

## DB foundation

| ID | Line | Note |
| --- | --- | --- |
| VAL-DB-001 | `ANALYZE` has run and statistics are populated | **Verified failing 2026-08-11.** `sqlite_stat1` is absent from the live database. Root cause R1 |
| VAL-DB-002 | Tuned PRAGMAs are applied on the live connection | **Partially met.** `cache_size`, `mmap_size`, and `busy_timeout` are set; `temp_store = MEMORY` is not |
| VAL-DB-003 | The window-title evidence query uses an index, not a 14K-row scan | Follows VAL-DB-001 |
| VAL-DB-004 | The `gatherConcurrentEvidence` `website_visits` query is sargable — a true two-sided range | |
| VAL-DB-005 | The `website_visits` `GROUP BY` no longer spills to a disk temp B-tree | |
| VAL-DB-006 | Function-wrapped date `GROUP BY`s are index-usable | |
| VAL-DB-007 | The `getAllAppsForLabeling` correlated subquery is replaced by a window function | |
| VAL-DB-008 | No new full-table scan on hot read paths — regression guard | |
| VAL-DB-009 | WAL checkpoint does not stall the main thread | |
| VAL-DB-010 | Big-table hot read queries use indexes — positive `EXPLAIN QUERY PLAN` | |

## Correctness preservation and cleanup

| ID | Line |
| --- | --- |
| VAL-CORRECT-001 | Typecheck, lint, and the full suite stay green |
| VAL-CORRECT-002 | A real-database backup snapshot exists before any migration runs |
| VAL-CORRECT-003 | Schema changes are additive only — no destructive migration |
| VAL-CORRECT-004 | `knip` findings are materially reduced against baseline |
| VAL-CORRECT-005 | Removed code is confirmed unreferenced by `knip` and by manual trace |
| VAL-CORRECT-006 | Protected core public behaviour and output are unchanged |
| VAL-CORRECT-007 | `depcheck` is triaged and the `recharts` decision is recorded |
| VAL-CORRECT-008 | The privacy and exclusion boundary still excludes after performance changes |
| VAL-BASELINE-001 | Baseline timings, the `EXPLAIN` set, and tool counts were recorded before any fix |

## Cross-cutting journeys

| ID | Line |
| --- | --- |
| VAL-CROSS-001 | A full mixed-navigation journey stays responsive end to end |
| VAL-CROSS-002 | Fresh capture surfaces across views while navigating |
| VAL-CROSS-003 | Correction, re-projection, and cross-view refresh stay coherent |

## Baseline

The original baseline is in the Factory mission directory, not in this repository:
`EXPLAIN QUERY PLAN` for sixteen hot queries, PRAGMA state, `knip` (4 files, 118
exports, 107 types), `depcheck`, a test count of 672, and a 507MB database
snapshot. It is superseded — the database is now roughly 1.2GB and the suite 2197
tests — so VAL-BASELINE-001 needs re-capturing before any of these lines is graded
against an improvement claim.
