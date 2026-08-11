# V2 six-lane sprint — what shipped, what did not

State of `main` at `f4cb36ce`, reconciled 2026-08-11. Read this before picking up any V2 work order. Its purpose is to stop anyone rebuilding something that already shipped.

## Verified state of `main`

- typecheck clean, lint 0 errors
- full suite **2412 pass / 0 fail / 9 skip** (350 files)
- strict Timeline evaluation **37/37 segmentation, 37/37 labels, 24/24 intent, 12/12 wraps, 29/29 facts**

The strict evaluation only reaches a perfect score with all six lanes combined. Several lanes were individually red on it; do not treat a red eval on a single lane branch as that lane's defect without checking against integration first.

## Scoreboard

32 work orders were assigned across six lanes. **26 delivered, 6 not.**

| Lane | Assigned | Delivered |
|---|---|---|
| `wave/1-runtime` | WO-95, 68, 73, 74, 76 | 4 of 5 — **WO-76 not started** |
| `wave/2-entities` | WO-34, 30, 33, 38, 41 | 5 of 5, **WO-30 and WO-38 partial** |
| `wave/3-retrieval` | WO-7, 6, 12, 18, 13 | 4 of 5 — **WO-13 not started** |
| `wave/4-voice` | WO-99, 102, 104, 105, 106, 107 | 6 of 6 |
| `wave/5-mcp` | WO-15, 17, 19, 20, 22, 37 | 6 of 6 |
| `wave/6-answers` | WO-53, 54, 55, 51, 56 | **1 of 5** |

Every work order carries its execution record in `.sw-factory/WO-<n>/` (context, implementation plan, review log, checklist). Software Factory statuses were reconciled to match: 24 `completed`, 2 `in_review` (the partials), 6 left `backlog` with flagged comments naming exactly what remains.

The six lane PRs (#117–#122) are closed. Their commits are in `main`; they were integrated through `factory/v2-integration` rather than the merge button, so GitHub could not close them automatically.

## Three traps

**1. WO-56 is 5/7 already done.** "Make time-chunk answers follow the Daylens voice policy" was largely delivered as WO-106 in the voice lane. Met: AC-AIA-005.1, 005.2, 005.4, 006.1, 006.3. Still open: **AC-AIA-005.3** (conflicting evidence is never detected or named) and **AC-AIA-006.2** (`renderTimeChunkAnswer` returns a header plus a table, with no direct natural-language answer alongside). Scope the work order down before assigning it.

**2. WO-51 contradicts observed behaviour.** It says to remove command-line provider modes because they cannot run the agent loop. On 2026-08-11 the AI tab ran on "Claude CLI · Claude Sonnet" against a Claude subscription and returned a correct, grounded answer that read GitHub history. Building WO-51 as written would delete a working path the owner pays for by subscription. Needs a product decision first, and it collides with issue #5.

**3. Issue #68's exact repro is still not covered.** WO-53 shipped deterministic fact enforcement, but `DeterministicFactKind` (`src/main/agent/deterministicFacts.ts:40`) is only `total_tracked_time | focus_time | app_total_time | app_count | site_count`. There is **no `site_total_time`**, so "how much time did I spend on Coursera this week" — a per-site duration — produces no deterministic fact and nothing overrides the model. The machinery is there; one fact kind is missing.

## What remains, per undelivered work order

- **WO-76** (renderer, Context Inspector) — backend is done and merged. `ChatAgentResult.evidence` is populated but no UI consumes it; `contextPacketInspection.ts` was not extended. This is the surface for data that already exists.
- **WO-13** (renderer, command palette) — retrieval backend is done. Must render the new "semantic unavailable, with reason" state rather than showing it as zero matches.
- **WO-54** (isolate untrusted tool output) — WO-22 already shipped the attribution half (tool-name namespacing, `[MCP:{serverName}]` prefixes). The trust boundary itself is unbuilt: nothing stops tool-returned content being read as instructions that widen permissions.
- **WO-55** (repository discovery) — untouched. Repository reading already works within the current path floor; this is about widening discovery across visible home-directory locations without breaking the boundary.
- **WO-51** — see trap 2.
- **WO-56** — see trap 1.

## Partials

- **WO-30** — write-through helpers (`adoptAppIdentityWrite`, `adoptArtifactWrite`, `adoptWebsiteVisitWrite`) exist and are tested; website visits are wired. Missing: call sites in `workBlocks.ts` (after `upsertArtifact`) and `appIdentityRegistry.ts` (after identity observation upsert).
- **WO-38** — `pruneEntitySupportForDeletedEvidence` / `pruneEntitySupportForConnectorSources` exist and are tested. Missing: nobody calls them when evidence rows are actually deleted (`trackingHistory.ts` and the connector-deletion path).

Both are call-site wiring, not rebuilds. Both were blocked only because those files belonged to another lane.

## Known gaps recorded by the lanes themselves

- **AC-AIA-002.3 is not verified end-to-end.** Evidence is produced but no UI consumes it. Closed by WO-76.
- **`SCHEMA_SQL` no longer describes the real `memory_records` table.** A fresh install builds the pre-v70 shape and migration v70 immediately rebuilds it. Harmless today, misleading to read.
- **`execGetDaySummary` still reads the uncorrected `getAppSummariesForRange`.** This is why the WO-53 enforcement is load-bearing rather than decorative.
- **Stored Wrapped narratives do not re-voice when the tone changes.** Deliberate: putting voice into `factsHash` would write a false `facts-changed` reason into the analysis ledger. A correct fix needs a stored-voice column.
- **The recap tone has no Settings control** — issue #124.

## Issue sync

Updated with evidence rather than closed, because each still has real work left: #5, #64, #68, #73, #80, #110.

Filed from acceptance testing: **#124** (tone unreachable after onboarding), **#125** (interface cleanup pass — sticky filters, week density, Settings controls, notifications).

Confirmed still reproducing on `main`: **#110** (blocks still titled "Cursor Agents" — read-path guards do not rewrite stored labels) and **#73** (screen context claims to be sampling while extraction is not installed; the frame backlog is now full at 100 frames / 61.2 MB, every one quarantined after 5 retries).
