# V2 six-lane sprint — what shipped, what did not

> **Superseded by [docs/V2-PLAN.md](V2-PLAN.md) (2026-09-04)** for V2 scope, status, and priority.
> This document keeps its detail; it no longer sets scope.


State of `main` at `f4cb36ce`, reconciled 2026-08-11. Read this before picking up any V2 work order. Its purpose is to stop anyone rebuilding something that already shipped.

Re-audited against the code on 2026-08-14 at `cf405e84`. No production code landed after `f4cb36ce` — the three commits since are documentation and the recap-tone Settings control. Corrections from that audit are marked below.

## Verified state of `main`

- typecheck clean, lint 0 errors
- full suite **2412 pass / 0 fail / 9 skip** (350 files) — re-run 2026-08-14, unchanged
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

**1. WO-56 is 5/7 already done.** "Make time-chunk answers follow the Daylens voice policy" was largely delivered as WO-106 in the voice lane. Met: AC-AIA-005.1, 005.2, 005.4, 006.1, 006.3. Still open: **AC-AIA-005.3** and **AC-AIA-006.2**. Both re-checked 2026-08-14.

AC-AIA-005.3 was recorded as "conflicting evidence is never detected or named", which overstates it. One conflict kind is detected and named: `correction_overrides_inference` (`src/main/services/contextPacket.ts:520`), rendered into the packet prompt at line 1420. What is missing is conflict between two pieces of evidence — the packet's `conflicts` array only ever carries that one kind, and a time-chunk answer never surfaces one.

AC-AIA-006.2: `renderTimeChunkAnswer` (`src/main/agent/timeChunkAnswer.ts:209`) still returns a date header plus a `| Time | Activity |` table and nothing else, and `chatAgent.ts:621` replaces the model's text with it outright.

Scope the work order down before assigning it.

**2. WO-51 contradicts observed behaviour.** It says to remove command-line provider modes because they cannot run the agent loop. On 2026-08-11 the AI tab ran on "Claude CLI · Claude Sonnet" against a Claude subscription and returned a correct, grounded answer that read GitHub history. Building WO-51 as written would delete a working path the owner pays for by subscription. Needs a product decision first, and it collides with issue #5.

**3. Issue #68's exact repro is still not covered.** WO-53 shipped deterministic fact enforcement, but `DeterministicFactKind` (`src/main/agent/deterministicFacts.ts:40`) is only `total_tracked_time | focus_time | app_total_time | app_count | site_count`. There is **no `site_total_time`**, so a per-site duration question produces no deterministic fact and nothing overrides the model. The machinery is there; one fact kind is missing. Re-checked 2026-08-14: unchanged.

## What remains, per undelivered work order

- **WO-76** (renderer, Context Inspector) — backend is done and merged. `ChatAgentResult.evidence` (`src/main/agent/chatAgent.ts:202`) is populated but no UI consumes it: `deterministicFacts`, `deterministicRepairs`, `supportedClaims`, `unsupportedClaims` and `disclosedUncertainties` have no reader outside `src/main/agent/`. `src/main/services/contextPacketInspection.ts` was not extended. This is not a new surface — `src/renderer/components/ContextPacketInspector.tsx` already exists and opens from the AI workspace ("What the AI saw") and from Settings. WO-76 extends that inspector; it does not build one.
- **WO-13** (renderer, command palette) — retrieval backend is done. Must render the new "semantic unavailable, with reason" state rather than showing it as zero matches. `CommandPalette.tsx` still calls `ipc.search.semantic` only, which returns rows and no status; the status channel (`search:semanticStatus`) is read by Settings and by nothing else, and the palette never calls the unified `planRetrieval` boundary that carries the reason.
- **WO-54** (isolate untrusted tool output) — WO-22 already shipped the attribution half (tool-name namespacing, `[MCP:{serverName}]` prefixes in `src/main/agent/mcpTools.ts:182`). The trust boundary itself is unbuilt: nothing stops tool-returned content being read as instructions that widen permissions. Nothing under `src/main/agent/` treats tool output as untrusted.
- **WO-55** (repository discovery) — not untouched, as previously recorded. A `discover_repositories` tool exists (`src/main/agent/systemTools.ts:565`), but its roots are only `~/Dev-*` (`devRoots`, same file line 113). `gitSignals.devScanRoots` already reaches one more location, `~/Documents/GitHub`. WO-55 is widening those roots across visible home-directory locations without breaking the path floor, not building discovery.
- **WO-51** — see trap 2.
- **WO-56** — see trap 1.

## Partials

- **WO-30** — write-through helpers (`adoptAppIdentityWrite`, `adoptArtifactWrite`, `adoptWebsiteVisitWrite`, all in `src/main/services/entities/entityAdoption.ts`) exist and are tested; only `adoptWebsiteVisitWrite` is wired, from `src/main/db/queries.ts:2761`. Missing: call sites in `src/main/services/workBlocks.ts` (after `upsertArtifact`, called at line 5362) and `src/main/core/inference/appIdentityRegistry.ts` (after identity observation upsert). Still true on 2026-08-14.
- **WO-38** — `pruneEntitySupportForDeletedEvidence` / `pruneEntitySupportForConnectorSources` (`src/main/services/entities/entitySupportLifecycle.ts`) exist and are tested. `pruneEntitySupportForConnectorSources` calls the first; nothing else calls either. Missing: a call when evidence rows are actually deleted (`src/main/services/trackingHistory.ts` and the connector-deletion path). Still true on 2026-08-14.

Both are call-site wiring, not rebuilds. Both were blocked only because those files belonged to another lane.

## Known gaps recorded by the lanes themselves

- **AC-AIA-002.3 is not verified end-to-end.** Evidence is produced but no UI consumes it. Closed by WO-76.
- **`SCHEMA_SQL` no longer describes the real `memory_records` table.** Confirmed 2026-08-14: `src/main/db/schema.ts:986` still omits the `page` record kind and the `domain` / `url` columns that migration v70 (`src/main/db/migrations.ts:3317`) adds. A fresh install builds the pre-v70 shape and v70 immediately rebuilds it. Harmless today, misleading to read.
- **`execGetDaySummary` still reads the uncorrected `getAppSummariesForRange`.** This is why the WO-53 enforcement is load-bearing rather than decorative.
- **Stored Wrapped narratives do not re-voice when the tone changes.** Deliberate: putting voice into `factsHash` would write a false `facts-changed` reason into the analysis ledger. A correct fix needs a stored-voice column.
- ~~**The recap tone has no Settings control**~~ — fixed in `40b8df58`. Settings > General now carries it, reusing `VOICE_SAMPLES` and onboarding's own persist path. Issue #124 closed.

## This repository is public

Treat it that way. Two rules that were being broken and are now enforced by review rather than tooling:

- **No real personal data in fixtures or comments.** `40b8df58` replaced real email addresses (the owner's work and student addresses, and a colleague's) that were sitting in `tests/labelVoice.test.ts`, `tests/windowTitleContext.test.ts`, `tests/enrichmentResolve.test.ts` and a comment in `src/shared/labelVoice.ts`. Build fixtures from invented activity. Note that the pre-fix values remain in git history.
- **No captured screenshots of real days.** The UX audit — its screenshots and its own `INDEX.md` and `ACCEPTANCE.md` — lives in the **private** `spcsorg/daylens-ux-audit` repository, because it carries calendar entries, colleague names and browsing history. Do not move it here. `docs/acceptance/INDEX.md` and `docs/acceptance/ACCEPTANCE.md` in this repository are different files: the graded dossier, written from Linear states and merged commits, with no captured activity in them. Keep it that way.

A scan for provider-shaped secrets (`sk-ant-`, `ghp_`, `AKIA`, `xoxb-`, Google API keys) returns only validator patterns in `providerValidation.ts`, `aiProvider.ts`, `credentialPatterns.ts` and the web key route. No live credentials are committed.

## Issue sync

Updated with evidence rather than closed, because each still has real work left: #5, #64, #68, #73, #80, #110.

Filed from acceptance testing: **#124** (tone unreachable after onboarding), **#125** (interface cleanup pass — sticky filters, week density, Settings controls, notifications).

Confirmed still reproducing on `main`: **#110** (blocks still titled "Cursor Agents" — read-path guards do not rewrite stored labels) and **#73** (screen context claims to be sampling while extraction is not installed; the frame backlog is now full at 100 frames / 61.2 MB, every one quarantined after 5 retries).
