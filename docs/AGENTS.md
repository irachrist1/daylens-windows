# Daylens Product And Build Contract

This file is the product contract for Daylens. It defines what the product is supposed to be.

For implementation status, current code and `docs/ISSUES.md` win over old prose. Do not use this file to claim that something is already shipped or validated.

## What Daylens Is

Daylens is a local-first desktop activity tracker for your laptop. It quietly logs what you're working on so you, and the AI tools you use, can ask grounded questions about your work history.

It should help answer questions like:

- "How much should I charge Client X based on how long I've been working on this for the past month?"
- "What did I do between 2-4 pm on Wednesday?"
- "Show me everything I touched for Project X. Why is it not working now if it worked yesterday?"

Daylens is not:

- an app-usage vanity dashboard
- a client-only freelancer tool
- a decorative AI chat wrapper

## Product Goal

The product works when a user can ask:

> How much time did I spend on X this week, and what exactly was I doing?

`X` can be a client, project, repo, class, research topic, internal initiative, document, or workstream.

## Core Mental Model

The user is doing work, not opening apps.

Apps, tabs, files, websites, meetings, and windows are evidence.
The primary unit of the system is a work session.
A work session can span multiple tools and still be one coherent block of work.

## Build Priorities

Always build in this order:

1. Tracking
2. Persistence
3. Timeline reconstruction
4. AI query execution
5. Apps surface usefulness
6. Settings simplicity
7. Advanced attribution

If tracking or persistence is broken, stop and fix that before polishing secondary UI.

## Cross-Platform Parity

Daylens ships as one desktop product across macOS, Windows, and Linux.

Hard rules:

- shared functionality should ship with cross-platform parity, not as a macOS-only idea that gets backfilled later
- platform-native surfaces may differ in implementation, but should preserve parity of user value
- if work is intentionally platform-specific, document the Windows and Linux expectation or mark parity pending in `docs/ISSUES.md`
- do not mark a shared capability done if it only feels finished on one platform

## Navigation Contract

Top-level navigation stays minimal and universal:

- Timeline
- Apps
- AI
- Settings

Do not make the product clients-first by default.

## Timeline Contract

The timeline is the proof surface of the product.

If the timeline is empty, broken, or reset after restart, the product is broken.

The timeline must:

- reconstruct from persisted data on load
- show prior tracked days and weeks
- display coherent work blocks
- support unattributed blocks without collapsing into blankness
- separate active time, gaps, and breaks clearly
- let the user drill into artifacts, apps used, and supporting evidence

The timeline must not:

- rely on renderer memory as the source of truth
- disappear after relaunch
- show raw terminal commands as the main story
- fall back to raw app names when better work context exists

### Work Block Heuristics

`src/main/services/workBlocks.ts` is allowed to be heuristic, but it should stay legible and stable because it shapes the core proof surface.

Current behavior to preserve unless there is a measured reason to change it:

- coherent app/session clusters can remain merged as one block
- slow-switch mixed runs can split into distinct tasks
- standalone meetings should split out instead of being buried
- high-context-switch developer testing flows can remain merged when splitting would create noise
- visible labels should prefer user override, then useful AI labels, then stable evidence- or rule-based labels
- background cleanup should revisit clearly weak legacy labels without churning already-good labels
- low-confidence or unattributed blocks should stay visible

When changing these heuristics:

- protect persistence and reconstruction first
- document material user-facing behavior changes in `docs/ISSUES.md`
- do not make the live timeline depend on AI availability

## Apps Surface Contract

The Apps view is secondary. It exists to explain how tools participated in real work.

It should answer:

- What was I working on when I used this app?
- Which files, tabs, docs, repos, or websites did I touch here?
- Which other tools commonly appeared in the same work sessions?

It should not prioritize:

- session counts
- vanity metrics
- raw bundle IDs
- generic filler summaries

## AI Contract

The AI surface must:

- execute starter prompts correctly
- support freeform queries
- stream chat responses visibly in the renderer while keeping provider calls in backend orchestration
- stay grounded in tracked local data
- support copy, retry, and feedback controls
- persist feedback locally and emit product telemetry for later review
- support charts, tables, artifacts, and reports when requested
- keep report/export generation inside the AI surface instead of growing a dedicated reports tab
- persist local chat threads in `ai_threads` and generated artifacts in `ai_artifacts` plus `userData/artifacts/`

Focus sessions, recap experiences, and report/export workflows should live inside the AI surface or be triggered from it unless there is a strong reason to create a separate entry point.

Truthfulness rules:

- deterministic first, AI second
- never block Timeline, Apps, or persisted history on AI
- keep labels stable and avoid visible churn
- route AI through a backend orchestration layer, not ad hoc renderer calls
- be honest that first-class structured attribution is currently strongest for clients and projects; broader workstreams may still rely on block and artifact evidence
- do not claim cross-surface desktop-to-web AI continuity unless the desktop is actually writing shared remote AI rows

## Settings Contract

Settings should stay sparse, functional, and honest.

Current allowed areas:

- Tracking
- Sync / workspace linking
- AI provider / key / routing
- Notifications
- Privacy / export / delete
- Launch and background behavior
- Appearance
- Updates
- Sparse category overrides where they directly improve reconstruction quality

Do not ship decorative settings, fake controls, membership fluff, or jargon-heavy dashboards.

## Lifecycle And Data Principles

The app must:

- continue running when the main window closes
- remain performant in the background
- recover state after restart or reboot
- preserve historical days and weeks
- detect idle periods, sleep, wake, and likely breaks

The database is the source of truth.

Keep the layered model:

- raw capture
- activity segments
- work sessions / work blocks
- rollups and query payloads

Never overwrite raw capture.
Never make renderer state the source of truth.

## Documentation And Audit Discipline

When updating docs:

- read code first, then docs
- treat existing docs as hypotheses to verify or correct
- use exact file references where helpful
- separate code-proven behavior from inferred behavior and runtime-validated behavior
- use language like `implemented pending verification` when code exists but runtime proof is missing
- keep `docs/ISSUES.md` as the status ledger instead of scattering status claims across other docs
- keep remote-companion docs aligned with the actual `daylens` and `daylens-web` code, not stale summaries

## What Must Never Ship

Do not ship:

- an empty timeline with tracking implied
- views that reset after restart
- dead prompt chips
- fake summaries from thin data
- app-centric metrics pretending to be work intelligence
- clients-first navigation for everyone
- decorative settings
- desktop UI that feels like a downgraded SaaS dashboard

## Definition Of Done

A change is not done until all of these are true:

1. Tracking works.
2. Data persists after restart.
3. Timeline shows real reconstructed blocks for today and prior days.
4. AI starter prompts execute.
5. Freeform AI questions return grounded responses.
6. Apps explains work, not just app frequency.
7. Settings contains only functional controls.
8. The UI feels calmer, cleaner, and more native than before.
