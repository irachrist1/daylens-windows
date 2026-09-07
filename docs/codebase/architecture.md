# Current architecture

> This document describes the current implementation. It is a navigation aid, not the source of truth. Verify its claims against the code before making a change. Last verified against a full code audit on 2026-07-26; where an older document contradicts this map, this map wins.

## System overview

Daylens is an Electron desktop application with a React renderer, a local SQLite database, platform-specific capture paths, an optional web companion, a local MCP server, and a separate managed billing service. It turns everything done on this computer into a private, queryable memory: capture (foreground app + window titles at 5s resolution, browser pages, idle/lock states) → interpretation (timeline blocks, work intent, entities, kinds) → three surfaces (Timeline, Apps, AI chat) plus Wrapped decks and scheduled briefs. AI writes prose only on top of deterministic facts; a validator rejects any line that contradicts them.

```text
macOS / Windows / Linux signals      consented external signals
                │                              │
                └──────── observations ────────┘
                               │
                         local SQLite
                               │
                sessions, evidence, corrections
                               │
                   projections and services
                               │
             Timeline / Apps / AI / search / MCP
                               │
                    optional filtered sync
                               │
                     Next.js + Convex web
```

## Process map

| Runtime | Entry | Role |
| --- | --- | --- |
| Main | `src/main/index.ts` | lifecycle, DB, IPC, schedules |
| Preload | `src/preload/index.ts` | the only renderer→main surface |
| Renderer | `src/renderer/App.tsx` | routes: `/timeline`, `/apps`, `/ai`, `/settings`; Wrapped is an overlay, not a route |
| MCP server | `packages/mcp-server` | read-only SQLite, same tool executors as the in-app agent, fails closed on malformed exclusion env |
| Range worker | `packages/range-worker` | Apps-view range reads off the main thread |
| Embed worker | `packages/embed-worker` | MiniLM ONNX inference |
| Capture relay | `packages/capture-relay` | drains the on-disk focus-event spool |
| Native helpers | `src/native/capture-helper` (Swift), `windows-capture-helper` (C#) | foreground/title/idle events |

The four `packages/*/src/index.ts` entries are referenced by vite configs and fork sites — knip flags them as unused; they are not.

## Desktop runtime

`src/main/index.ts` owns the Electron lifecycle. It initializes settings and the database, registers IPC handlers, starts tracking when onboarding and privacy settings allow it, starts supporting schedules, creates the main window, and optionally starts the MCP server.

Platform capture enters through services under `src/main/services`. macOS and Windows have different adapters and fallbacks. Browser evidence is read separately and reconciled with foreground-browser time before it contributes to user-facing totals.

`src/main/services/database.ts` opens the local `better-sqlite3` database. The schema and forward-only migrations live under `src/main/db`; most existing reads and writes remain in the broad `src/main/db/queries.ts` module while narrower repositories are introduced incrementally. Focus events are the first migrated slice: the typed contract in `src/main/core/evidence/focusEvent.ts` validates helper events through one capture gate, and `src/main/db/focusEventRepository.ts` owns their reads and writes.

## The data spine

`app_sessions` + `website_visits` + `activity_state_events` → `timeline_blocks`/`timeline_block_members`/`timeline_block_labels` → corrections (`timeline_block_reviews`, `block_label_overrides`, `evidence_exclusions`, `correction_undo_log`) → entities → memory → `external_signals` (git/calendar/focus enrichment) → `day_snapshots` (frozen per-day facts, versioned) → `ai_*` (threads, artifacts, usage).

Invariants that must hold:

1. **Attention is the budget.** Only foreground `app_sessions` measure time. Browser history *explains* attention; per-domain credit goes through `reconcileWebsiteVisits`/`getCorrectedWebsiteSummariesForRange` (interval union + foreground clamp). No raw `SUM(duration_sec)` anywhere.
2. **One clamp everywhere.** Day totals and per-block `websites` use the same corrected variant (fixed 2026-07-26; blocks previously used the raw one, which let a background Netflix tab outvote real work).
3. **Kind follows intent.** A block whose dominant category is focused work is `work`, on the build path and the rehydrated read path alike (`effectiveBlockKind`). Leisure naming draws only from leisure domains.
4. **Subjects name the work, never the tool.** `workNameGuards` rejects tool brands, tool surfaces ("Cursor Agents", "New chat - Claude"), command lines, joined tab titles; `workIntent.subjectFromArtifact` skips them so a real document/channel/repo can name the block. Slack channel artifacts resolve to their project name. No email address ever enters a subject.
5. **AI is groundable prose only.** `wrapFactTable` enumerates every number a line may contain; `wrapNarrativeShared` validates and repairs once; failed lines fall back per slide. Chart plumbing (the "Other" bucket) never reaches the model.
6. **Wraps regenerate when a completed day's facts moved** (same-day opens reconcile; the frozen-at-10:38am failure mode is gone).
7. **Privacy is layered**: capture-time exclusion, purge, and the `filterTrackingExcludedEvidence` boundary before anything AI/MCP-bound. App-name exclusion tokens match case-sensitively so excluding "Messages" does not redact the word "messages".

## Interpretation pipeline

What makes it "activity, not tabs":

1. `workBlocks.ts` — heuristic segmentation with boundary reasons.
2. `workIntent.ts` — role (execution/research/communication/review/…) + subject, ranked artifact > page > workflow > domain, guarded per invariant 4.
3. `workKind.ts` — work/leisure/personal, distribution-first.
4. `analyzeDay.ts` — AI regroup + relabel, versioned (`day_analysis_versions`), heuristic fallback with no provider. Carries an `interpretationAgentEnabled` flag whose packet-based runtime is NOT wired yet — that runtime is where the agentic interpretation defined in [agent runtime and context](../specs/agent-runtime-and-context.md) lands.
5. `dayWrapScenes.buildDayWrapFacts` — the one reconciled facts object per day (activities, ribbon, story beats, standout, hooks, quality gate).
6. `wrappedNarrative.ts` (lib + service) — prompt build, validation, repair, fallback, cache keyed by date + facts hash.

The interpretation rules themselves — the attention budget, the naming ladder, threads, gaps, freshness — are specified in [Timeline](../specs/timeline.md) and [Day recap and analysis](../specs/day-recap-and-analysis.md).

## Renderer boundary

The React application lives in `src/renderer`. `src/renderer/App.tsx` exposes the primary routes:

- `/timeline`
- `/apps`
- `/ai`
- `/settings`

The renderer does not access SQLite or Electron services directly. `src/preload/index.ts` exposes a typed API that calls registered main-process IPC handlers. Shared request and response types live in `src/shared`.

When adding behavior, keep policy in the main process or a pure shared module. The renderer should present product facts rather than independently recalculate them.

## Agent flow

The desktop AI surface sends a typed request over IPC to the main process. `src/main/agent/chatAgent.ts` is a real tool loop (AI-SDK `streamText`, max 14 steps) with tiered context escalation:

- **Tier 1 (free):** the activity database — `daylensTools` + wrapped tools.
- **Tier 2 (cheap, permission-carded):** `read_file`/`list_dir`/`search_files` (deny-by-default grants, disclosure ledger), read-only `git`, `discover_repositories`.
- **Tier 3 (expensive, consent-gated):** `capture_screen` — one downscaled still of the active display via the screen-context frame source; pixels go to the model as an image part and are never stored; the mandatory `reason` appears in the activity trail. Gated on the Screen context experiment toggle + OS permission; refuses honestly otherwise. (Added 2026-07-26.)

Plus: context packets with a sources inspector, grounding verification with one corrective retry, clarifying questions, pause/resume checkpoints, previewed/undoable corrections, confirmed-memory proposals, user-configured MCP servers.

Agent tools read Daylens data through existing services and queries. A tool should expose a product-level fact or explicit command, not raw tables or a second definition of time and attribution. Provider choice, retries, streaming, cancellation, and rate limits belong to agent infrastructure. Recorded activity remains product data rather than model output. The tier model and its policy gate are specified in [agent runtime and context](../specs/agent-runtime-and-context.md).

## Web and sync

`apps/web` contains the public site, linked web interface, and Convex backend. Desktop capture remains the primary source of activity. The remote contract in `packages/remote-contract` defines the filtered payload shared between desktop and web.

The current sync path sends live presence and selected day-level facts. Raw capture rows, full file paths, and unrestricted page data are not part of the normal cloud boundary. `apps/web` + Convex sync is frozen pending the encrypted companion replacement (docs/product/v2.md). See [Web companion](web.md) for the implementation snapshot and current gaps.

## MCP

`packages/mcp-server` is a local stdio server bundled and launched by the desktop app when enabled. External clients also spawn it. It opens the database read-only, reuses the same tool executors as the in-app agent, and fails closed on a malformed exclusion environment. It is another consumer of Daylens facts and should not invent a parallel activity model.

Each external tool call is appended to `mcp-activity.jsonl` next to the database (tool name, timestamp, sanitized arguments, success/outcome — not the result). The AI tab reads that sidecar over `ai:get-mcp-activity` and shows a plain feed. Settings → Enrichment sources discovers MCP servers from Claude Desktop, Claude Code (`~/.claude.json`, including project-scoped `mcpServers`), and Cursor (`~/.cursor/mcp.json`).

## Billing

The desktop can call a configured provider directly with a person’s own key. Managed AI access uses `services/billing`, which tracks entitlements and provider cost without storing prompts, answers, or raw activity. See [Billing operations](../operations/billing.md).

## Decisions recorded 2026-07-26

- **Connector framework removed.** `src/main/connectors/` (OAuth adapters: Google/Outlook Calendar, GitHub, Linear, Granola + settings UI + IPC) was dropped as a product decision: developer-credential setup, zero real-world connections, DEV-256. Tables and migrations remain; readers of `connector_records` degrade to empty. Calendar/git enrichment continues via `externalSignals.ts` (zero-setup local probes), which is also the intended future home of any reborn integration — as agent-pluggable evidence, not a settings page.
- **Old recap stack removed** (`renderer/lib/recap.ts`, `getRecapRange` IPC, recap sync-allowlist keys) — superseded by the wrap deck.
- **Dead report generators removed** (`reportArtifacts.ts`, `reportFormats.ts`) — live export is `interactionTools` xlsx/csv + `weeklyExport`.
- **Screen-context capture** (`services/screenContext/`) stays: consent-gated sampler + encrypted store + lifecycle, no shipped extractor yet. It now also serves the agent's Tier-3 live capture. Reconcile marketing copy ("no screenshots, ever") with this before any release that enables it.

## Known contradictions and open work

- **Focus score / distraction alerter** are marked "Removed" in `docs/product/v2.md` but fully live (`focusScore.ts`, `distractionAlerter` started at boot, Settings UI, MCP tool). Decide: revive the spec or remove the feature. Left in place because it is live product surface, not dead code.
- **Interpretation agent runtime** — flag exists, runtime unwired (see above). Highest-leverage next build.
- **Block segmentation can bridge untracked gaps** (a lunch inside one "block") and gaps are not yet first-class facts for the narrative — the rules are in [Timeline §Segmentation](../specs/timeline.md) and [Day recap §Gaps](../specs/day-recap-and-analysis.md).
- **`apps/web` + Convex sync is frozen** pending the encrypted companion replacement (docs/product/v2.md).
- **Plaintext API key** found in the LEGACY app-data dir (`~/Library/Application Support/Daylens/config.json`, old GRDB-era app): rotate that key and delete the file; the current app keeps keys in the OS secure store.

## Current architectural risks

- `src/main/index.ts`, `src/main/db/queries.ts`, and several services own broad responsibilities.
- Similar facts are still assembled along more than one path.
- Capture, projection, correction, and presentation boundaries are not yet consistently enforced.
- The renderer and external interfaces can drift if shared product queries are not used.
- Local validation cannot prove deployed Convex and web parity.

Changes to these areas are made one behavior slice at a time. Existing databases, user corrections, and a runnable application must be preserved throughout the migration.

## Dependency direction

The intended direction is:

```text
interfaces → application services → domain logic → shared primitives
                         infrastructure ↗
```

Domain logic should not depend on Electron, React, model SDKs, or hidden global state. Infrastructure implements the platform, database, provider, and external-service interfaces that the application needs.
