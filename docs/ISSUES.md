# Issues

Status captured from a code-first audit on 2026-04-23.

This file is the implementation-status ledger. Items below are separated into code-proven, `implemented pending verification`, and still-partial/open. Older docs and summaries were treated as hypotheses during this refresh.

## Code-Proven Today

### Desktop Tracking And Persistence

- Foreground tracking persists real sessions to SQLite and recovers a persisted live-session snapshot after restart (`src/main/services/tracking.ts:981-1071`, `src/main/services/tracking.ts:1395-1470`).
- Linux tracking diagnostics explicitly report `ready`, `limited`, or `unsupported` depending on session/backend availability (`src/main/services/tracking.ts:196-299`).
- Timeline day payloads are rebuilt from persisted sessions plus the live session, not renderer memory (`src/main/services/workBlocks.ts:1849-1880`).
- Timeline blocks, members, labels, artifact mentions, and workflow occurrences are persisted in dedicated tables (`src/main/services/workBlocks.ts:1438-1607`).

### Timeline Surface

- Desktop Timeline has day/week modes, explicit gap rendering, block inspection, and a week-review slot (`src/renderer/views/Timeline.tsx:834-1182`, `src/renderer/views/Timeline.tsx:1184-1545`).
- Empty-state copy is truthful about relying on persisted local activity (`src/renderer/views/Timeline.tsx:1478-1491`).

### Apps Surface

- Desktop Apps merges live-session time into summaries and loads contextual app detail plus app narrative (`src/renderer/views/Apps.tsx:36-73`, `src/renderer/views/Apps.tsx:144-245`).

### AI Surface

- Desktop AI supports starter prompts, freeform chat, deterministic routing before LLM fallback, streaming, retry/copy/rating controls, focus-session actions, persistent local threads, and local artifacts (`src/main/services/ai.ts:3715-3993`, `src/main/services/artifacts.ts:24-170`, `src/main/services/artifacts.ts:261-408`, `src/renderer/views/Insights.tsx:787-804`, `src/renderer/views/Insights.tsx:957-965`, `src/renderer/views/Insights.tsx:1083-1372`, `src/renderer/views/Insights.tsx:1608-1715`).
- AI orchestration is centralized in the main process with per-job routing, provider fallback, prompt redaction, and usage telemetry (`src/main/services/aiOrchestration.ts:54-185`, `src/main/services/aiOrchestration.ts:245-474`).

### Settings And Sync Controls

- Desktop Settings already exposes workspace linking, browser link creation, recovery words, sync-state display, provider routing, prompt caching, redaction toggles, category overrides, and Linux diagnostics (`src/renderer/views/Settings.tsx:824-999`, `src/renderer/views/Settings.tsx:1000-1334`).
- Sync status is derived from durable sync outcome plus heartbeat freshness. A newer durable failure still wins over a fresh heartbeat (`src/main/services/syncState.ts:5-24`, `tests/syncStatus.test.ts`).

### Remote Foundation

- The shared remote contract package exists and is used across repos (`packages/remote-contract/index.ts:1-318`, `src/shared/snapshot.ts:1`, `tests/remoteContractCheck.test.ts`).
- Desktop remote payload shaping strips block artifact refs and rewrites page labels to privacy-safe domain labels (`src/main/services/remoteSync.ts:43-69`, `src/main/services/remoteSync.ts:192-227`, `tests/remoteSyncPayload.test.ts`).
- `daylens-web` already exposes `Timeline`, `Apps`, `AI`, and `Settings` navigation (`/Users/tonny/Dev-Personal/daylens-web/app/components/AppChrome.tsx:58-165`).
- Web session reads are scoped to `sessionKind === "web"` (`/Users/tonny/Dev-Personal/daylens-web/app/lib/session.ts:15-41`).

## Implemented Pending Verification

These features exist in code and, in several cases, have focused test coverage, but this audit did not re-prove them end-to-end in real runtime use.

- Provider-backed chat quality and failure handling across supported desktop AI providers.
- Week review and app narrative usefulness in live user conditions (`src/main/services/aiOrchestration.ts:91-108`, `src/renderer/views/Timeline.tsx:886-890`, `src/renderer/views/Apps.tsx:217-245`).
- Report/export artifact generation and downstream open/share flows on packaged apps.
- Focus-session start/stop/review flows from AI messages in normal usage (`src/renderer/views/Insights.tsx:1229-1282`).
- Linked remote freshness, stale-state UX, and session-repair behavior under real multi-device use (`src/main/services/syncUploader.ts:232-284`).
- Packaged runtime validation across macOS, Windows, and Linux.

## Still Partial Or Open

### Browser Evidence

- Linux browser-history ingestion is not implemented in `src/main/services/browser.ts`. Current browser ingestion is macOS/Windows only (`src/main/services/browser.ts:74-107`, `src/main/services/browser.ts:414-620`).

### Structured Attribution

- Snapshot export currently loads first-class entity rollups for `client` and `project` only (`src/main/services/snapshotExporter.ts:279-321`).
- The shared remote contract allows `repo` and `topic` entity kinds, so the broader type surface is ahead of the exporter’s current implementation (`packages/remote-contract/index.ts:153-159`).

### Remote AI Continuity

- Desktop local thread metadata already stores `workspaceThreadId`, but desktop does not yet sync shared remote AI thread/message/artifact rows (`src/main/services/artifacts.ts:339-342`, `packages/remote-contract/index.ts:287-318`).
- Web AI persistence is real for web-originated flows, but true desktop-to-web thread continuation remains unimplemented.

### Remote Read Path

- `daylens-web` still uses both the new `remoteSync` truth-table path and a legacy `snapshots` path. `/api/snapshots?full=1` still queries the legacy list endpoint (`/Users/tonny/Dev-Personal/daylens-web/app/api/snapshots/route.ts:35-40`, `/Users/tonny/Dev-Personal/daylens-web/convex/snapshots.ts:88-231`).

### Validation Scope

- This audit inspected code and tests. It did not re-run full packaged-app validation, real linked-workspace remote validation, or full provider-backed AI validation across platforms.

## Tests That Support Current Behavior

- `tests/browserDiscovery.test.ts`: browser discovery behavior and diagnostics.
- `tests/remoteSyncPayload.test.ts`: privacy-filtered remote sync shaping.
- `tests/focusScoreV2.test.ts`: focus score V2 behavior.
- `tests/recap.test.ts` and `tests/recap.stress.test.ts`: recap truthfulness rules.
- `tests/analytics.test.ts` and `tests/analytics.service.test.ts`: telemetry sanitization and opt-in behavior.
- `tests/followUpChat.test.ts`, `tests/aiThreadSchema.test.ts`, `tests/aiThreadDeletion.test.ts`: AI follow-up, thread schema, and deletion behavior.
- `tests/syncStatus.test.ts`: sync-state derivation logic.
- `tests/blockCleanup.test.ts`: selective cleanup/relabel behavior.

## Real Runtime Or User Verification Still Needed

- Windows packaged runtime validation on a real machine.
- Linux packaged runtime validation on real desktops, including X11 and Wayland/XWayland scenarios.
- End-to-end linked workspace creation, browser linking, heartbeat/day-sync freshness, and stale/failure recovery in normal use.
- Desktop provider-backed AI chat, report generation, and focus-session action flows with real credentials.
- Desktop-to-web AI continuity after the shared remote AI persistence is actually implemented.
