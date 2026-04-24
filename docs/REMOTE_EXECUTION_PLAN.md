# Daylens Remote Execution Plan

Status: post-audit execution plan on 2026-04-23

This is the next-step plan after auditing the current implementation. It assumes the shared contract, heartbeat/day-sync split, and web shell already exist in code.

## Current Starting Point

Already in code:

- shared remote contract package
- heartbeat/live presence uploads
- durable day sync uploads
- sync-state derivation
- remote truth-table storage in `daylens-web`
- web shell with `Timeline`, `Apps`, `AI`, `Settings`
- web-originated remote AI threads/artifacts

Not yet finished:

- desktop-to-web AI continuity
- full retirement of legacy snapshot reads
- broader remote Apps and search parity
- real runtime validation across linked devices and platforms

## Execution Order

### 1. Prove The Existing Truth Layer

Goal:

- validate the foundation that already exists before widening scope

Work:

- real linked-workspace desktop-to-browser validation
- stale/failure-state validation under real disconnect/recovery scenarios
- packaged-app validation for workspace linking and sync status on macOS, Windows, and Linux

Why first:

- the current code already has the right architecture, but the truthfulness risk is now mostly runtime validation, not missing scaffolding

### 2. Finish Shared AI Continuity

Goal:

- make desktop and web use one remote workspace-thread model

Work:

- write desktop AI turns/artifacts into the shared remote AI rows
- load those rows on web
- preserve local-first desktop behavior while enabling continuation remotely

Why next:

- the contract already exists, and this is the biggest remaining product gap between desktop AI and web AI

### 3. Remove The Remaining Legacy Snapshot Read Path

Goal:

- make `remoteSync` the sole remote proof path

Work:

- replace remaining legacy `snapshots` full-read dependency
- keep migration compatibility only as long as necessary
- update docs once the legacy path is truly out of active product flow

### 4. Deepen Remote Proof Surfaces

Goal:

- improve remote usefulness without inventing new top-level surfaces

Work:

- strengthen remote Apps context from synced work blocks and artifacts
- add indexed remote search over synced proof entities
- improve day/week/month remote recap usefulness only after continuity and truth are solid

### 5. Broaden Attribution Carefully

Goal:

- close the gap between the remote contract’s type surface and the exporter’s actual entity coverage

Work:

- decide whether to truly support `repo` and `topic` as first-class exported entities
- otherwise narrow the contract/docs so they stop implying more than the exporter produces

## Exit Criteria For The Next Major Remote Pass

- real linked-workspace validation is documented separately from code-only proof
- desktop and web can continue the same remote AI thread
- `remoteSync` is the active read path for normal remote proof flows
- `docs/ISSUES.md` and remote docs remain aligned with the code after each step
