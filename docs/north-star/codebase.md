# Daylens codebase — verified map (2026-07-26)

Written from a full code audit, not from prior docs. Where this contradicts
older documents, this wins. Companion docs: the product north star in
[gap-analysis-2026-07-20.md](gap-analysis-2026-07-20.md), the inference model
in [activity-understanding.md](activity-understanding.md), the agent design
in [context-agent.md](context-agent.md).

## What Daylens is

An Electron app that turns everything done on this computer into a private,
queryable memory: capture (foreground app + window titles at 5s resolution,
browser pages, idle/lock states) → interpretation (timeline blocks, work
intent, entities, kinds) → three surfaces (Timeline, Apps, AI chat) plus
Wrapped decks and scheduled briefs. AI writes prose only on top of
deterministic facts; a validator rejects any line that contradicts them.

## Process map

| Runtime | Entry | Role |
|---|---|---|
| Main | `src/main/index.ts` | lifecycle, DB, IPC, schedules |
| Preload | `src/preload/index.ts` | the only renderer→main surface |
| Renderer | `src/renderer/App.tsx` | routes: `/timeline`, `/apps`, `/ai`, `/settings`; Wrapped is an overlay, not a route |
| MCP server | `packages/mcp-server` | read-only sqlite, same tool executors as the in-app agent, fails closed on malformed exclusion env |
| Range worker | `packages/range-worker` | Apps-view range reads off the main thread |
| Embed worker | `packages/embed-worker` | MiniLM ONNX inference |
| Capture relay | `packages/capture-relay` | drains the on-disk focus-event spool |
| Native helpers | `src/native/capture-helper` (Swift), `windows-capture-helper` (C#) | foreground/title/idle events |

The four `packages/*/src/index.ts` entries are referenced by vite configs and
fork sites — knip flags them as unused; they are not.

## The data spine

`app_sessions` + `website_visits` + `activity_state_events` →
`timeline_blocks`/`timeline_block_members`/`timeline_block_labels` →
corrections (`timeline_block_reviews`, `block_label_overrides`,
`evidence_exclusions`, `correction_undo_log`) → entities → memory →
`external_signals` (git/calendar/focus enrichment) → `day_snapshots` (frozen
per-day facts, versioned) → `ai_*` (threads, artifacts, usage).

Invariants that must hold:

1. **Attention is the budget.** Only foreground `app_sessions` measure time.
   Browser history *explains* attention; per-domain credit goes through
   `reconcileWebsiteVisits`/`getCorrectedWebsiteSummariesForRange` (interval
   union + foreground clamp). No raw `SUM(duration_sec)` anywhere.
2. **One clamp everywhere.** Day totals and per-block `websites` use the same
   corrected variant (fixed 2026-07-26; blocks previously used the raw one,
   which let a background Netflix tab outvote real work).
3. **Kind follows intent.** A block whose dominant category is focused work
   is `work`, on the build path and the rehydrated read path alike
   (`effectiveBlockKind`). Leisure naming draws only from leisure domains.
4. **Subjects name the work, never the tool.** `workNameGuards` rejects tool
   brands, tool surfaces ("Cursor Agents", "New chat - Claude"), command
   lines, joined tab titles; `workIntent.subjectFromArtifact` skips them so a
   real document/channel/repo can name the block. Slack channel artifacts
   resolve to their project name. No email address ever enters a subject.
5. **AI is groundable prose only.** `wrapFactTable` enumerates every number a
   line may contain; `wrapNarrativeShared` validates and repairs once; failed
   lines fall back per slide. Chart plumbing (the "Other" bucket) never
   reaches the model.
6. **Wraps regenerate when a completed day's facts moved** (same-day opens
   reconcile; the frozen-at-10:38am failure mode is gone).
7. **Privacy is layered**: capture-time exclusion, purge, and the
   `filterTrackingExcludedEvidence` boundary before anything AI/MCP-bound.
   App-name exclusion tokens match case-sensitively so excluding "Messages"
   does not redact the word "messages".

## Interpretation pipeline (what makes it "activity, not tabs")

1. `workBlocks.ts` — heuristic segmentation with boundary reasons.
2. `workIntent.ts` — role (execution/research/communication/review/…) +
   subject, ranked artifact > page > workflow > domain, guarded per
   invariant 4.
3. `workKind.ts` — work/leisure/personal, distribution-first.
4. `analyzeDay.ts` — AI regroup + relabel, versioned
   (`day_analysis_versions`), heuristic fallback with no provider. Carries an
   `interpretationAgentEnabled` flag whose packet-based runtime is NOT wired
   yet — that runtime is where the agentic interpretation from
   [context-agent.md](context-agent.md) lands.
5. `dayWrapScenes.buildDayWrapFacts` — the one reconciled facts object per
   day (activities, ribbon, story beats, standout, hooks, quality gate).
6. `wrappedNarrative.ts` (lib + service) — prompt build, validation, repair,
   fallback, cache keyed by date + facts hash.

## The agent

`src/main/agent/chatAgent.ts`: a real tool loop (AI-SDK streamText, max 14
steps) with tiered context escalation:

- **Tier 1 (free):** the activity database — `daylensTools` + wrapped tools.
- **Tier 2 (cheap, permission-carded):** `read_file`/`list_dir`/
  `search_files` (deny-by-default grants, disclosure ledger), read-only
  `git`, `discover_repositories`.
- **Tier 3 (expensive, consent-gated):** `capture_screen` — one downscaled
  still of the active display via the screen-context frame source; pixels go
  to the model as an image part and are never stored; the mandatory `reason`
  appears in the activity trail. Gated on the Screen context experiment
  toggle + OS permission; refuses honestly otherwise. (Added 2026-07-26.)

Plus: context packets with an inspector ("what the AI saw"), grounding
verification with one corrective retry, clarifying questions, pause/resume
checkpoints, previewed/undoable corrections, confirmed-memory proposals,
user-configured MCP servers.

## Decisions recorded here (2026-07-26)

- **Connector framework removed.** `src/main/connectors/` (OAuth adapters:
  Google/Outlook Calendar, GitHub, Linear, Granola + settings UI + IPC) was
  dropped as a product decision: developer-credential setup, zero real-world
  connections, DEV-256. Tables and migrations remain; readers of
  `connector_records` degrade to empty. Calendar/git enrichment continues via
  `externalSignals.ts` (zero-setup local probes), which is also the intended
  future home of any reborn integration — as agent-pluggable evidence, not a
  settings page.
- **Old recap stack removed** (`renderer/lib/recap.ts`, `getRecapRange`
  IPC, recap sync-allowlist keys) — superseded by the wrap deck.
- **Dead report generators removed** (`reportArtifacts.ts`,
  `reportFormats.ts`) — live export is `interactionTools` xlsx/csv +
  `weeklyExport`.
- **Screen-context capture** (`services/screenContext/`) stays: consent-gated
  sampler + encrypted store + lifecycle, no shipped extractor yet. It now
  also serves the agent's Tier-3 live capture. Reconcile marketing copy
  ("no screenshots, ever") with this before any release that enables it.

## Known contradictions and open work

- **Focus score / distraction alerter** are marked "Removed" in
  `docs/product/v2.md` but fully live (`focusScore.ts`, `distractionAlerter`
  started at boot, Settings UI, MCP tool). Decide: revive the spec or remove
  the feature. Left untouched here because it is live product surface, not
  dead code.
- **Interpretation agent runtime** — flag exists, runtime unwired (see
  above). Highest-leverage next build.
- **Block segmentation can bridge untracked gaps** (a lunch inside one
  "block") and gaps are not yet first-class facts for the narrative — design
  in [activity-understanding.md](activity-understanding.md) §Gaps.
- **`apps/web` + Convex sync is frozen** pending the encrypted companion
  replacement (docs/product/v2.md).
- **Stored AI block labels predating the name guards** still carry tool-y
  names ("Working on Cursor Agents"); they heal on re-analysis, not
  retroactively.
- **Plaintext API key** found in the LEGACY app-data dir
  (`~/Library/Application Support/Daylens/config.json`, old GRDB-era app):
  rotate that key and delete the file; the current app keeps keys in the OS
  secure store.

## Verification map

- `npm test` — 320+ hermetic files, one Electron process each.
- `npm run timeline:eval -- --strict` — 14 evidence-fixture days scoring
  segmentation/labels/intent/wrap-facts cross-surface consistency. One
  pre-existing label miss (`mixed-browser-ai-day`) fails strict on main.
- `npm run wrapped:bench` — LLM-judged wrap quality gate on a copy of the
  real DB (needs a real key; spends provider calls).
- `npm run test:behaviour` — 16 live chat-agent scenarios judged against
  gold answer shapes ("activity not app" is an explicit fail axis).
- `npm run verify:shipping` — the whole release gate.
- `tests/wrapped-bench/debug.ts <date>` — reproduce the exact production
  wrap prompt for any real day; `probe-facts.ts <date>` prints the day's
  computed facts. Both were the primary instruments for the 2026-07-20
  gap-analysis fixes.
