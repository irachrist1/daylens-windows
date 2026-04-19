# Issues

## Current Known Constraints

- Real-machine Windows validation still matters even when tests pass.
- Unsigned Windows builds will still trigger SmartScreen warnings.
- The repo is still historically named `daylens-windows` even though the app now spans macOS, Windows, and Linux.
- Linux still needs real-machine validation on both X11 and Wayland sessions even after CI packaging lands.

## Current Validation Snapshot

Status captured during the final launch-gate pass on 2026-04-19.

Ship-readiness closure work added persistent AI chat threads + a durable artifact library (`ai_threads` / `ai_artifacts` tables + on-disk files under `userData/artifacts/`) inside the AI surface, a Focus score V2 heuristic (coherence + deep-work density + artifact progress + demoted context-switching penalty) in `src/main/lib/focusScore.ts` and wired through `snapshotExporter.ts`, explicit Anthropic / OpenAI model selectors in the advanced AI settings block, simplified Timeline block-label override UI (one input + Save / Reset), independently scrolling Timeline inspector columns, broad Settings copy cleanup, a macOS auto-update support branch in `updater.ts`, and new PostHog events (`focus_session_started` / `focus_session_stopped` / `artifact_created` / `ai_thread_created` / `ai_thread_archived` / `ai_thread_deleted`) that flow through the existing PII-safe allow-list scrubber. In this 2026-04-19 pass, `npm run typecheck`, `npm run build:all`, `npm run test:ai-chat` (35/35), `npm run test:entity-prompts` (17/17), and `git diff --check` all passed locally, and PR #9 stayed green on GitHub.

- macOS: packaged artifacts were built in this repo (`dist-release/Daylens-1.0.26-arm64.dmg`, `dist-release/Daylens-1.0.26-arm64.zip`, and `dist-release/mac-arm64/Daylens.app`). Launching that packaged app explicitly from `dist-release/mac-arm64/Daylens.app` showed the current `Timeline / Apps / AI / Settings` shell and reconstructed persisted local history in a real macOS window.
- macOS: the live GitHub release surface has now been corrected. `v1.0.26` is the published latest release, it carries `latest-mac.yml`, `latest.yml`, and `latest-linux.yml` on the same shared tag, and the stale `v1.0.26-win` release was removed so downloads now resolve through one unified release page. End-to-end packaged updater behavior still remains implemented pending verification until a real packaged app is pointed at this live release and successfully updates.
- macOS: provider-backed AI flows are still unproven here. Anthropic key presence was confirmed locally, but AI starter prompts, one freeform provider-backed question, visible streaming, focus-session AI flows, and report/export artifact generation were not honestly exercised end to end from the packaged window in this pass.
- macOS: close-the-window / keep-tracking / reopen, workspace creation/linking/disconnect, explicit artifact open-action handoff, and end-to-end block rename/reset interactions also remain unproven. The packaged app log did show `tracking` recovering a live session snapshot after relaunch, but that is weaker than a real user validation of close-window survival and reopen behavior.
- macOS: this machine also still has an older installed `/Applications/Daylens.app` that can respawn and collide with automation. This pass intentionally targeted the packaged bundle path directly and used screenshots, process inspection, and log inspection instead of overstating what app-name-based automation proved.
- Windows: build targets, packaging config, and release workflow surfaces can be audited from this machine, but runtime behavior remains implemented pending verification until it is exercised on a real Windows machine.
- Linux: focused-window fallback wiring, diagnostics surfaces, packaging config, smoke script wiring, and release workflows can be audited from this machine, but runtime behavior remains implemented pending verification until it is exercised on real X11 and Wayland sessions. CI packaging alone is not treated as runtime proof.

## Launch Scope

### Pre-PR Launch Scope

- Make this repo the single cross-platform source of truth for macOS, Windows, and Linux.
- Finish core information parity: tracking, persistence, timeline, AI, apps, settings, exports, packaging, and release verification.
- Migrate the Linux runtime/release work that still matters out of `daylens-linux`.
- Prepare `daylens-linux` as a public MIT transition repo that points contributors back here.
- Keep statuses as `upon review` / `implemented pending verification` until real user validation happens.

### Post-PR Follow-On Scope

- Wrapped / daily-weekly-monthly recap UI in the AI surface.
- Recap notification polish and rollout tuning once the launch-critical parity work is stable.

## TickTick Triage

Imported from the Daylens backlog in TickTick on 2026-04-18.

### Open In This Electron Repo

- `Windows: Build Focus Sessions UI in AI chat tab` — implemented pending verification. The AI surface now exposes chat-triggered focus session start / stop / review flows inside the existing chat cards, but the provider-backed end-to-end flow was not exercised in this launch-closure pass and still needs real user validation plus packaged-app validation before it should be called done.
- `Windows/Mac/linux Bug: Build Sync/Workspace UI in Settings` — implemented pending verification. Settings now exposes workspace status, creation, browser linking, recovery words, and disconnect flows. The local-only state rendered cleanly in the macOS Electron dev run on 2026-04-18, but workspace creation / linking was not exercised there and still needs real user validation across platforms.
- `Windows/Mac/linux BUG: Wire distraction alerter to invalidation events` — implemented pending verification. Distraction checks are now triggered by tracking pulses and focus-session changes, and notification clicks route back into the app, but the actual UX still needs real-world validation.
- `Windows/Mac/linux BUG: Persist thumbs up/down ratings to DB` — implemented pending verification. Ratings are now persisted with AI messages and still emit product analytics, but the full collection loop still needs user validation and reporting review.
- `Windows/Mac/linux: Fine-tune AI chat responses` — the AI surface is much stronger now, but this is still an open quality pass rather than a clearly finished item. Followup prompts need to be improved a little bit too.
- `Windows/Mac/linux: Build App Category Customization in Settings` — implemented pending verification. Settings now exposes sparse top-app category overrides, and the override controls rendered in the macOS Electron dev run on 2026-04-18, but changing and resetting a category still needs real usage validation because automation could not reliably drive the selector in this pass.
- `Windows/Mac/linux: Build Block Label Override (rename timeline blocks)` — implemented pending verification. Timeline block inspection now exposes local rename/reset actions, and the override UI rendered in the macOS Electron dev run on 2026-04-18, but the actual rename/reset interaction still needs user validation before it should be called done.
- `Windows/Mac/linux: Build Reports/Export view` — implemented pending verification. By design this now lives in the AI surface instead of a dedicated reports tab: report/export requests can generate grounded Markdown, CSV, and HTML chart artifacts from chat, the artifacts strip in the AI surface now persists and previews/opens/exports them through a new `ai_artifacts` table + `userData/artifacts/` folder, and artifacts link back to their generating thread via `ai_threads`. Provider-backed end-to-end generation + the downstream open/share flow across platforms still need real user validation.
- `Windows/Mac/linux: Persist AI chat threads + artifact library` — implemented pending verification. Added `ai_threads` + `ai_artifacts` tables, backfilled legacy `ai_messages` rows into a single `Imported chat` thread per conversation, added thread switcher + artifacts strip + preview panel inside the AI surface, and exposed 10 new thread/artifact IPC channels via `preload/index.ts`. Vercel AI SDK and Vercel Sandbox were evaluated and intentionally not adopted — Electron + SQLite + on-disk files already deliver stronger local persistence than those patterns assume, and Sandbox is a web-first primitive that would add weight without matching the local-first contract.
- `Windows/Mac/linux: Focus score V2` — implemented pending verification. `computeFocusScoreV2` replaces the focused-seconds ratio with `0.35*coherence + 0.25*deep_work_density + 0.20*artifact_progress + 0.20*(1 - switch_penalty)`; `snapshotExporter.ts` now derives its inputs from `getTimelineDayPayload` so scoring reflects real work-block boundaries, not raw category ratios. `tests/focusScoreV2.test.ts` covers coherence reward, switch penalty, artifact saturation, and window-title fallback.
- `Windows/Mac/linux: Explicit model selector in Settings` — implemented pending verification. The advanced AI controls block in Settings now exposes Anthropic and OpenAI model selects; strategy is unchanged (`balanced | quality | economy | custom`) and the model override applies when strategy is `custom`. The existing Update button is preserved. No new IPC route; persists via the existing `ipc.settings.set` path.
- `Windows/Mac/linux BACKEND: Wire Anthropic prompt caching (cache_control headers)` — implemented pending verification. Anthropic request-side cache controls now keep the reusable system prompt on an explicit breakpoint for `stable_prefix` jobs, add Anthropic's top-level automatic cache breakpoint on multi-turn `stable_prefix` requests so the reusable conversation prefix can advance between turns, and still mark only the newest repeated user payload for `repeated_payload` jobs while respecting the prompt-caching toggle. Local tests now validate those request shapes, but real provider-side cache-read/cache-write confirmation still has not been observed from this environment.
- `Windows/Mac/linux BACKEND: Implement streaming for chat responses` — implemented pending verification. The renderer now receives streamed chat text through main-process orchestration, but the provider-backed in-progress / completion flow was not exercised in this launch-closure pass. Explicit incremental streaming proof still needs broader provider and UX validation across the supported routes.
- `Windows/Mac/linux BACKEND: Finish Linux focused-window parity in the unified repo` — implemented pending verification. Linux tracking now carries Hyprland, Sway, and X11/XWayland fallback paths plus ready / limited / unsupported diagnostics in Settings, but it still needs real-machine validation across those runtime combinations.
- `Windows/Mac/linux BACKEND: Refactor attribution to generic entity model OR document client-only scope` — implemented pending verification for client and project routing. Deterministic entity routing, follow-ups, and report/export generation now cover both clients and projects, but repos, classes, research topics, and internal workstreams still rely more heavily on block/artifact evidence than on a true generic entity layer.
- `Windows/Mac/linux BACKEND: Document workBlocks.ts formation heuristics` — implemented pending verification in canonical docs so the block-formation rules are no longer only implicit in code.
- `Windows/Mac/linux BACKEND: Wire week_review and app_narrative AI jobs` — implemented pending verification. Apps detail rendered useful narrative content in the macOS Electron dev run on 2026-04-18, but Timeline week review was intentionally not exercised in this pass because it triggers provider-backed AI work. The final UX still needs user validation.
- `Windows/Mac/linux BACKEND: Fix nightly block cleanup — too slow for backlog` — implemented pending verification. Background cleanup now sweeps unresolved persisted dates, unresolved unpersisted history dates, and legacy weak-AI dates from the local database, marks already-good deterministic labels as reviewed so AI relabeling stays focused on unresolved backlog blocks, and can revisit only obviously weak legacy AI labels when they are still generic fallback labels. Broader "full-history cleanup" or "all low-confidence AI labels get reopened" wording would still be overstated because already-good AI labels, user overrides, and merely low-confidence-looking AI-labeled history are not automatically reopened yet.
- `Windows/Mac/linux release: Add Linux packaging, smoke validation, and release workflows to the unified repo` — implemented pending verification. The active repo now carries Linux builder targets and CI workflow scaffolding, but it still needs end-to-end validation on real releases.
- `Windows/Mac/linux repo transition: Turn daylens-linux into a MIT-licensed transition repo` — implemented pending verification. The transition repo now carries an MIT license, a cleaned README that points contributors back to the unified repo, and only the Linux-specific docs that still help with runtime validation, but the final public-facing read still needs user confirmation.

### Already Landed Or Mostly Addressed

- `Windows BACKEND: Fix model tier routing — economy jobs using Opus` — fixed. Economy and balanced tiers now use cheaper models, and Opus is hard-pinned only for `report_generation`.
- `Windows/Mac/linux scope lock: Keep focus sessions inside AI and keep Wrapped out of the launch PR` — landed in docs. Focus sessions stay inside the AI surface; Wrapped remains explicitly post-PR.

## Documentation Rules

- Keep only these canonical docs up to date:
  - `docs/CLAUDE.md`
  - `docs/AGENTS.md`
  - `README.md`
  - `docs/ABOUT.md`
  - `docs/IDEAS.md`
  - `docs/ISSUES.md`

- Do not reintroduce parallel strategy docs, redesign specs, or duplicate architecture notes unless they are actively maintained and clearly necessary.
