# Daylens Product And Build Contract

This file is the single project memory for Daylens. If code, mocks, old notes, or previous decisions conflict with this file, this file wins.

## What Daylens Is

Daylens is a cross-platform activity tracker for your laptop. It quietly logs what you're working on so you, and the AI tools you use, can ask grounded questions about your work history.

It should help answer questions like:

- "How much should I charge Client X based on how long I've been working on this for the past month?"
- "What did I do between 2-4 pm on Wednesday?"
- "Show me everything I touched for Project X. Why is it not working now if it worked yesterday?"

Daylens is Google for your workday history, and Spotify Wrapped for how you actually spend your time.

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

- rely on in-memory state as the source of truth
- disappear after relaunch
- show raw terminal commands as the main story
- fall back to raw app names when better work context exists

### Work Block Heuristics

`workBlocks.ts` is allowed to be heuristic, but it should stay legible and stable because it shapes the core proof surface.

Current formation rules to preserve unless there is a measured reason to change them:

- coherent app/session clusters can stay merged as one work block
- mixed runs can split when slow-switch boundaries suggest two distinct tasks
- standalone meetings should split into their own blocks instead of being buried inside adjacent work
- developer testing or high-context-switch flows can remain one heuristic block when splitting would create noise
- closed blocks may get AI relabeling, but the visible label should prefer meaningful overrides first, then useful AI/rule-based labels, then safe fallbacks
- overnight cleanup should sweep backlog history in background batches, relabel unlabeled blocks, and revisit obviously weak legacy AI labels such as generic fallback labels; already-good AI labels are not automatically reopened yet, and already-good deterministic labels should stay stable and be marked reviewed instead of churned
- unattributed or low-confidence blocks should still remain visible rather than collapsing into blankness

When changing these heuristics:

- protect persistence and reconstruction first
- document the user-facing effect in `docs/ISSUES.md` if behavior changes materially
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
- keep report/export generation inside the AI surface instead of growing a dedicated reports tab unless there is a strong measured reason to change that

Focus sessions, recap experiences, and report/export workflows should live inside the AI surface or be triggered from it unless there is a strong reason to create a separate entry point. Focus session start / stop / review flows belong here, not in a new top-level route.

Current attribution truthfulness for launch:

- first-class attributed entities currently include clients and projects
- repos, classes, research topics, and internal initiatives may still rely on work-block and artifact evidence when no structured attribution exists
- contributors should prefer honest evidence-grounded answers over pretending every workstream already has full entity attribution

AI is an orchestration layer over deterministic local data, not the primary runtime of the product.

Non-negotiable rules:

- deterministic first, AI second
- never block timeline, apps, or persisted history on AI
- keep labels stable and avoid visible churn
- route AI through a backend orchestration layer, not ad hoc renderer calls

## Settings Contract

Settings should be simple, sparse, and real.

Allowed categories:

- Tracking
- AI provider / key
- Notifications
- Privacy / export / delete
- Launch and background behavior
- Optional onboarding / profile preferences

Customization such as app category overrides should fit the existing sparse settings shape without turning Settings into a cluttered control panel.

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
- work sessions
- rollups and query payloads

Never overwrite raw capture.
Never make renderer state the source of truth.

## Documentation And Status Discipline

AI contributors should update the canonical docs as part of the same change whenever product behavior, backlog status, workflow, or constraints have changed enough that the docs would otherwise drift.

When updating docs:

- keep `README.md`, `docs/ABOUT.md`, `docs/AGENTS.md`, `docs/CLAUDE.md`, `docs/IDEAS.md`, and `docs/ISSUES.md` aligned
- treat documentation updates as part of the job, not optional cleanup the user has to keep asking for
- mark shipped-sounding status carefully
- use language like `upon review`, `ready for review`, `implemented pending verification`, or `needs user validation` unless the user explicitly confirms the work is done
- do not mark an issue as fully fixed, complete, shipped, or resolved just because code was written
- ask the user whether they tested it and whether it worked before moving something from review status to done/fixed
- keep real implementation status in `docs/ISSUES.md` instead of scattering status notes across the other docs

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
6. Apps view explains work, not just app frequency.
7. Settings contain only functional controls.
8. The UI feels calmer, cleaner, and more native than before.
