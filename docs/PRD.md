# Daylens Remote Companion PRD

Status: code-audited refresh on 2026-04-23

This document describes what the remote companion actually is right now, based on the current `daylens` and `daylens-web` code. It is not a speculative roadmap doc.

## Product Role

The desktop app remains the capture engine and local source of truth.

The remote companion exists to expose selected, privacy-filtered Daylens evidence away from the laptop:

- current presence and freshness
- synced day summaries
- synced work blocks
- synced entities
- synced artifacts
- web-originated AI threads and artifacts

It is not a browser-first tracker and it is not yet a full cloud mirror of every local capability.

## Code-Proven Remote Product Today

### 1. Workspace Linking

Desktop can:

- create an anonymous workspace
- derive/store recovery words locally
- mint browser link codes
- recover a workspace from the mnemonic
- disconnect cleanly

Code references:

- `src/main/services/workspaceLinker.ts:64-178`
- `src/renderer/views/Settings.tsx:864-999`
- `/Users/tonny/Dev-Personal/daylens-web/convex/workspaces.ts:48-93`

### 2. Split Sync Model

Remote sync is already split into:

- heartbeat/live presence
- durable day sync

Desktop sends heartbeat on a short cadence and durable day-sync payloads separately. Desktop sync status is derived from durable sync success/failure and heartbeat freshness, so a fresh heartbeat does not automatically erase a newer durable-sync failure.

Code references:

- `src/main/services/syncUploader.ts:11-18`
- `src/main/services/syncUploader.ts:125-202`
- `src/main/services/syncState.ts:5-24`
- `/Users/tonny/Dev-Personal/daylens-web/convex/remoteSync.ts:32-45`

### 3. Privacy-Filtered Remote Payloads

Desktop does not upload raw block artifact IDs or broad page-title text as the standard remote proof boundary. Remote payload shaping rewrites work blocks and top pages into privacy-filtered forms before upload.

Code references:

- `src/main/services/remoteSync.ts:43-69`
- `src/main/services/remoteSync.ts:192-227`
- `tests/remoteSyncPayload.test.ts`

### 4. Web Product Surface

The web companion already exposes the intended top-level product model:

- `Timeline`
- `Apps`
- `AI`
- `Settings`

Code references:

- `/Users/tonny/Dev-Personal/daylens-web/app/components/AppChrome.tsx:58-165`

Current route mapping:

- `Timeline` is still implemented through `/dashboard` and related history routes.
- `Apps` has its own route and client.
- `AI` lives in `/chat`.
- `Settings` has a dedicated page with sync and provider status.

### 5. Remote Timeline Proof Surface

The web can render a desktop-style Timeline proof surface when the synced payload is snapshot v2. Timeline summary reads already come from `remoteSync` truth-table queries. A legacy snapshot path still exists for some full-fetch behavior.

Code references:

- `/Users/tonny/Dev-Personal/daylens-web/app/api/snapshots/route.ts:20-41`
- `/Users/tonny/Dev-Personal/daylens-web/app/components/SnapshotContent.tsx:16-35`
- `/Users/tonny/Dev-Personal/daylens-web/convex/remoteSync.ts:319-339`
- `/Users/tonny/Dev-Personal/daylens-web/convex/snapshots.ts:88-231`

### 6. Remote AI Surface

The web AI surface already has:

- recap presentation
- thread grouping
- artifact listing
- copy/download affordances
- user-facing provider failure states

This persistence is real for web-originated remote AI usage today.

Code references:

- `/Users/tonny/Dev-Personal/daylens-web/app/components/GlobalChat.tsx:21-89`
- `/Users/tonny/Dev-Personal/daylens-web/app/components/GlobalChat.tsx:121-139`
- `/Users/tonny/Dev-Personal/daylens-web/app/components/GlobalChat.tsx:247-320`

## What Is Not Yet True

These claims would currently overstate the product:

- Desktop-to-web AI thread continuation is not finished. The remote contract defines shared workspace AI thread/message/artifact shapes, but desktop does not yet upload those rows.
- The web is not fully off the legacy snapshot path. `remoteSync` truth tables exist, but the legacy `snapshots` path still remains in the codebase.
- Remote Apps parity is partial. There is a remote Apps surface, but it is still lighter than the desktop Apps detail model.
- Remote AI parity is partial. Web threads/artifacts exist, but desktop and web do not yet share one end-to-end conversation store.

## Product Rules Going Forward

- Desktop stays the capture engine.
- Sync freshness must stay truthful.
- Remote proof should stay work-block-centered, not app-metric-centered.
- Do not widen the remote payload boundary casually.
- Do not call cross-surface AI continuity done until desktop and web are writing and reading the same workspace AI rows.
