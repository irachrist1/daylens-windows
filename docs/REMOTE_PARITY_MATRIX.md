# Daylens Remote Parity Matrix

Status: code-audited refresh on 2026-04-23

This matrix records what desktop has, what web/remote has in code, and whether that parity is code-proven, `implemented pending verification`, or still partial.

| Capability | Desktop code | Remote/web code | Status | What still needs proof or work |
|---|---|---|---|---|
| Workspace creation and recovery | Mnemonic-based create/recover, browser link, disconnect (`src/main/services/workspaceLinker.ts:64-178`) | Web recovery/session issuance exists (`daylens-web/convex/workspaces.ts:48-93`) | Code-proven | Real linked-workspace user validation across devices |
| Sync truth | Heartbeat + durable day sync are split; sync state derived from durable success/failure plus heartbeat freshness (`src/main/services/syncUploader.ts:125-202`, `src/main/services/syncState.ts:5-24`) | Remote truth tables and session-scoped status reads exist (`daylens-web/convex/remoteSync.ts`) | Code-proven | Real stale/failure UX validation |
| Timeline proof surface | Persisted blocks, gaps, day/week views, drill-down (`src/main/services/workBlocks.ts:1438-1607`, `src/renderer/views/Timeline.tsx:1184-1545`) | Desktop-style Timeline renders from v2 snapshots; summaries/day/range route through remoteSync (`daylens-web/app/components/SnapshotContent.tsx:16-35`, `daylens-web/app/api/snapshots/route.ts:20-41`) | Implemented pending verification | Full retirement of legacy snapshot reads and real linked-workspace validation |
| Apps surface | Contextual app summaries and detail/narrative (`src/renderer/views/Apps.tsx:144-245`) | Dedicated `Apps` nav and client exist (`daylens-web/app/components/AppChrome.tsx:58-165`, `daylens-web/app/components/AppsDayClient.tsx`) | Partial | Remote Apps is still lighter than desktop context depth |
| AI surface | Persistent local threads/artifacts, recap, streaming, retry/copy/rating, focus actions (`src/renderer/views/Insights.tsx:957-1715`) | Web AI threads/artifacts UI exists (`daylens-web/app/components/GlobalChat.tsx`) | Partial | Desktop-to-web shared AI continuity is not implemented yet |
| Reports and artifacts | Local artifact persistence/open/export exists (`src/main/services/artifacts.ts:24-170`) | Web artifact listing exists | Implemented pending verification | End-to-end cross-surface artifact continuity |
| Settings | Tracking, Sync, AI, Labels, Notifications, Appearance, Updates, Privacy (`src/renderer/views/Settings.tsx:799-1334`) | Remote Settings page exists with sync/provider checks (`daylens-web/app/(app)/settings/page.tsx`) | Implemented pending verification | Real deployed-environment validation |
| Recap inside AI | Desktop recap is real in the AI surface (`src/renderer/views/Insights.tsx:1608-1715`) | Web AI recap panel exists (`daylens-web/app/components/GlobalChat.tsx:247-320`) | Implemented pending verification | Broader runtime validation and usefulness review |
| Structured entities | Snapshot export emits clients/projects (`src/main/services/snapshotExporter.ts:279-321`) | Contract allows more kinds (`packages/remote-contract/index.ts:153-159`) | Partial | Either broaden exporter or narrow contract/docs |
| Browser evidence | macOS/Windows browser history capture exists (`src/main/services/browser.ts:74-107`, `src/main/services/browser.ts:414-620`) | Remote receives privacy-filtered browser-derived evidence via synced work blocks | Partial | Linux browser history capture still absent |

## Parity Summary

Code-proven foundation:

- workspace linking
- sync truth model
- remote shell/navigation
- privacy-filtered sync payloads

Main remaining parity gaps:

- desktop-to-web AI continuity
- full remote Apps/context parity
- broader entity export parity
- linked multi-device runtime validation
