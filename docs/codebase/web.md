# Web companion

> This document describes the current `apps/web` implementation. Verify it against the code before relying on it.

## Purpose

`apps/web` contains the public Daylens site, the linked browser experience, and the Convex backend used for linking, filtered sync, and web AI. It is not a separate tracker. The desktop application remains the capture engine and local source of truth.

The linked surfaces and sync are frozen per the V2 disposition list: they continue to operate but receive no new features, and the web companion specification defines their encrypted replacement.

## Implemented now

- Public marketing, documentation, download, status, and changelog routes.
- Workspace creation, recovery, link-code redemption, and session cookies.
- Linked Timeline, Apps, AI, and Settings navigation over legacy route internals.
- Desktop heartbeat and filtered day sync through the shared remote contract.
- Convex storage for sync runs, failures, day summaries, work blocks, entities, artifacts, live presence, and web AI rows.
- A compatibility snapshot endpoint rebuilt from the newer synced tables.
- Web AI threads, messages, and deterministic report or export artifacts.

## Current data flow

```text
desktop SQLite
    │ selected and privacy-filtered remote contract
    ▼
Convex HTTP endpoints
    │
synced facts + workspace state + web AI rows
    │
Next.js routes and linked interface
```

The desktop sends `/remote/heartbeat` for live presence and `/remote/syncDay` for selected day facts. Remote payload shaping removes raw window titles, raw page titles, raw URLs, and raw block artifact references before upload. The `privacyFiltered` field records that the payload was filtered at the boundary.

## Privacy boundary

Standard sync includes summarized day facts, blocks, entities, artifacts, run state, and live presence. Raw capture tables, unrestricted browser history, and full local file paths remain outside the standard cloud boundary.

## Important entry points

| Path                              | Responsibility                                             |
| --------------------------------- | ---------------------------------------------------------- |
| `apps/web/convex/schema.ts`       | Convex data model                                          |
| `apps/web/convex/http.ts`         | Linking, heartbeat, sync, and compatibility HTTP endpoints |
| `apps/web/convex/remoteSync.ts`   | Synced writes and Timeline reads                           |
| `apps/web/convex/webAiThreads.ts` | Web AI thread and message persistence                      |
| `apps/web/app/(app)`              | Linked browser interface                                   |
| `apps/web/app/api`                | Authenticated Next.js API routes                           |
| `packages/remote-contract`        | Versioned desktop and web payloads                         |

## Known limitations

- Timeline still uses legacy route structure and compatibility-shaped adapters.
- Desktop does not yet upload shared cloud AI thread continuity.
- Web AI is less capable than desktop AI.
- Search, review flows, and richer artifacts do not yet have a complete remote-native proof surface.
- Local checks cannot prove deployed Convex parity; staging and production smoke tests require real credentials.
