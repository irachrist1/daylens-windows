# Daylens Remote + Desktop SRS

Status: code-audited refresh on 2026-04-23

This SRS describes the current system as implemented across the desktop repo and the paired `daylens-web` repo. Where older planning docs disagree, the code wins.

## 1. Desktop System

### 1.1 Persistence Model

The desktop app uses SQLite as the durable source of truth. Migrations run through schema version 20.

Code references:

- `src/main/db/migrations.ts:1181-1218`
- `src/main/db/schema.ts`

Relevant persisted domains visible in code:

- app sessions and live session snapshot
- website visits
- activity state events
- focus sessions
- timeline blocks, members, labels, overrides
- artifacts and artifact mentions
- AI messages, threads, artifacts, conversation state, summaries, usage events
- attribution-layer tables for clients, projects, and daily entity rollups

### 1.2 Tracking Engine

Desktop tracking:

- polls every 5 seconds
- persists live-session snapshots every 15 seconds
- treats 2 minutes as provisional idle and 5 minutes as away
- recovers persisted live sessions after restart
- records lock/suspend/resume-aware presence changes

Code references:

- `src/main/services/tracking.ts:67-71`
- `src/main/services/tracking.ts:196-299`
- `src/main/services/tracking.ts:981-1071`
- `src/main/services/tracking.ts:1124-1178`
- `src/main/services/tracking.ts:1395-1470`

### 1.3 Browser Ingestion

Browser history ingestion currently supports:

- macOS Chromium-family browsers
- Windows Chromium-family browsers
- Windows Firefox

It does not currently provide Linux browser-history capture in this service.

Code references:

- `src/main/services/browser.ts:74-107`
- `src/main/services/browser.ts:414-620`

### 1.4 Timeline Reconstruction

Timeline blocks are derived heuristically from sessions, then persisted to timeline tables. Day payloads are rebuilt from persisted sessions and the live session, with gaps explicitly represented.

Code references:

- `src/main/services/workBlocks.ts:68-80`
- `src/main/services/workBlocks.ts:1212-1349`
- `src/main/services/workBlocks.ts:1438-1607`
- `src/main/services/workBlocks.ts:1849-1880`
- `src/renderer/views/Timeline.tsx:1474-1537`

### 1.5 AI Orchestration

Desktop AI is orchestrated in the main process.

Code-proven characteristics:

- per-job definitions for block naming, day summary, week review, app narrative, chat, report generation, and attribution assist
- provider/model tier tables
- fallback across providers on auth/quota failures
- prompt redaction for file paths and emails
- usage-event persistence and analytics for every AI job

Code references:

- `src/main/services/aiOrchestration.ts:54-185`
- `src/main/services/aiOrchestration.ts:245-474`
- `src/shared/analytics.ts:3-73`
- `src/shared/analytics.ts:88-269`

### 1.6 Desktop AI Surface

Renderer-visible behavior already implemented:

- starter prompts
- day/week/month recap entry
- freeform chat
- streaming deltas
- retry/copy/rating controls
- focus-session start/stop/review actions
- thread switcher and thread deletion
- artifact preview/open/export

Code references:

- `src/renderer/views/Insights.tsx:787-804`
- `src/renderer/views/Insights.tsx:957-965`
- `src/renderer/views/Insights.tsx:1083-1282`
- `src/renderer/views/Insights.tsx:1317-1372`
- `src/renderer/views/Insights.tsx:1608-1715`

## 2. Sync And Remote System

### 2.1 Workspace Identity

Desktop workspace linking is anonymous and mnemonic-based. Device identity and session tokens are stored locally, and browser linking uses a display code plus full token.

Code references:

- `src/main/services/workspaceLinker.ts:64-118`
- `src/main/services/workspaceLinker.ts:120-198`

### 2.2 Remote Sync Pipeline

Desktop sync runtime:

- sends heartbeat every 15 seconds
- attempts durable day sync every 60 seconds
- marks dirty days and syncs them separately
- retries with stored-workspace repair on session-style auth failures

Code references:

- `src/main/services/syncUploader.ts:11-18`
- `src/main/services/syncUploader.ts:125-202`
- `src/main/services/syncUploader.ts:232-284`

### 2.3 Remote Payload Contract

The shared contract package already exists and exports:

- snapshot v2 types
- sync/presence types
- workspace AI thread/message/artifact types

Code references:

- `packages/remote-contract/index.ts:1-318`
- `src/shared/snapshot.ts:1`

Important current caveats:

- `EntityRollup.kind` allows `client | project | repo | topic`, but desktop snapshot export currently loads only `client` and `project` rows (`src/main/services/snapshotExporter.ts:279-321`).
- `WorkBlockSummary.labelSource` is normalized to `user | ai | rule` in the remote contract even though the local timeline block logic distinguishes `artifact` and `workflow` before export (`src/main/services/workBlocks.ts:1301-1349`, `packages/remote-contract/index.ts:74-94`).

### 2.4 Remote Cloud Storage

The web backend already stores remote truth-table data in dedicated tables such as:

- `workspace_live_presence`
- `sync_runs`
- `sync_failures`
- `synced_day_summaries`
- `synced_work_blocks`
- `synced_entities`
- `synced_artifacts`

Code references:

- `/Users/tonny/Dev-Personal/daylens-web/convex/remoteSync.ts`

The web also still keeps a legacy `day_snapshots` path in parallel:

- `/Users/tonny/Dev-Personal/daylens-web/convex/snapshots.ts:88-231`
- `/Users/tonny/Dev-Personal/daylens-web/app/api/snapshots/route.ts:35-40`

### 2.5 Web Sessions

Remote browser sessions are explicitly scoped to `sessionKind === "web"`.

Code references:

- `/Users/tonny/Dev-Personal/daylens-web/app/lib/session.ts:15-41`

### 2.6 Web Surfaces

Web shell navigation already maps to the intended product surfaces:

- Timeline
- Apps
- AI
- Settings

Code references:

- `/Users/tonny/Dev-Personal/daylens-web/app/components/AppChrome.tsx:58-165`

## 3. Proven Vs. Unproven

Code-proven:

- desktop local tracking/persistence/timeline
- desktop AI orchestration, threads, artifacts, recap surface
- workspace linking and sync-state derivation
- privacy-filtered remote payload shaping
- web truth-table reads and product shell

Inferred from code but not fully runtime-proven in this audit:

- expected freshness of remote sync under real multi-device use
- provider-backed AI quality and failure recovery in normal user conditions
- packaged runtime parity across all three desktop platforms

Known unverified or partial:

- Linux browser history capture
- desktop-to-web shared AI continuity
- full retirement of legacy web snapshot reads

## 4. Test Coverage Used In This Audit

The current repo includes focused tests that describe behavior in these areas:

- recap truthfulness: `tests/recap.test.ts`, `tests/recap.stress.test.ts`
- focus score v2: `tests/focusScoreV2.test.ts`
- browser discovery: `tests/browserDiscovery.test.ts`
- remote payload privacy shaping: `tests/remoteSyncPayload.test.ts`
- sync-state derivation: `tests/syncStatus.test.ts`
- analytics sanitization: `tests/analytics.test.ts`, `tests/analytics.service.test.ts`
- AI thread schema/deletion behavior: `tests/aiThreadSchema.test.ts`, `tests/aiThreadDeletion.test.ts`
- contract drift: `tests/remoteContractCheck.test.ts`
