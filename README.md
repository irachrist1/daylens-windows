# Daylens

Daylens is a local-first desktop activity tracker for macOS, Windows, and Linux. It captures app sessions, browser history, focus sessions, and reconstructed work blocks so you can inspect your day in `Timeline`, explain tool usage in `Apps`, and ask grounded questions in `AI`.

This README was refreshed from the current code on 2026-04-23. Existing docs were treated as hypotheses, not authority.

## What The Code Shows Today

- Tracking runs in the desktop main process, polls foreground activity every 5 seconds, persists a live-session snapshot every 15 seconds, and recovers that snapshot after restart so the timeline is not purely in-memory (`src/main/services/tracking.ts:67-71`, `src/main/services/tracking.ts:981-1071`, `src/main/services/tracking.ts:1124-1178`, `src/main/services/tracking.ts:1395-1470`).
- Browser history ingestion exists for macOS and Windows. The current implementation reads Chromium history on both platforms and Firefox history on Windows. Linux browser history capture is not implemented in this service today (`src/main/services/browser.ts:74-107`, `src/main/services/browser.ts:385-410`, `src/main/services/browser.ts:414-620`).
- Timeline reconstruction is persisted to SQLite `timeline_*` tables, includes gaps and low-activity compression, and rebuilds day payloads from persisted sessions plus the live session when present (`src/main/services/workBlocks.ts:1212-1349`, `src/main/services/workBlocks.ts:1438-1607`, `src/main/services/workBlocks.ts:1849-1880`, `src/renderer/views/Timeline.tsx:1184-1545`).
- Focus score V2 is implemented as a heuristic over coherence, deep-work density, artifact progress, and switch penalty, with a window-title fallback when artifact extraction is absent (`src/main/lib/focusScore.ts:71-177`, `tests/focusScoreV2.test.ts`).
- The AI surface is real, not placeholder UI. It supports starter prompts, freeform chat, deterministic routing before LLM fallback, renderer-visible streaming, local thread persistence, artifact persistence, retry/copy/rating controls, and inline focus-session actions (`src/main/services/ai.ts:3715-3993`, `src/main/services/aiOrchestration.ts:54-185`, `src/main/services/aiOrchestration.ts:245-474`, `src/main/services/artifacts.ts:24-170`, `src/main/services/artifacts.ts:261-408`, `src/renderer/views/Insights.tsx:787-804`, `src/renderer/views/Insights.tsx:1083-1372`, `src/renderer/views/Insights.tsx:1608-1715`).
- Settings already includes Tracking, Sync, AI, Labels, Notifications, Appearance, Updates, and Privacy sections. Workspace creation, browser linking, recovery words, sync-state display, provider routing, prompt-caching toggles, and redaction toggles are all present in code (`src/renderer/views/Settings.tsx:799-1334`).
- Optional remote sync is implemented as a split between heartbeat/live presence and durable day sync. Desktop builds privacy-filtered remote payloads, uploads heartbeat every 15 seconds, uploads dirty days every 60 seconds, and derives sync status from durable success/failure plus heartbeat freshness (`src/main/services/remoteSync.ts:43-143`, `src/main/services/remoteSync.ts:192-289`, `src/main/services/syncUploader.ts:11-18`, `src/main/services/syncUploader.ts:125-202`, `src/main/services/syncState.ts:1-24`, `src/main/services/workspaceLinker.ts:64-198`).
- The paired web repo already has `Timeline`, `Apps`, `AI`, and `Settings` navigation, remote truth-table reads, web-only AI thread persistence, and a desktop-style Timeline surface when snapshot v2 data exists (`/Users/tonny/Dev-Personal/daylens-web/app/components/AppChrome.tsx:58-165`, `/Users/tonny/Dev-Personal/daylens-web/app/api/snapshots/route.ts:20-41`, `/Users/tonny/Dev-Personal/daylens-web/app/components/SnapshotContent.tsx:16-35`, `/Users/tonny/Dev-Personal/daylens-web/app/components/GlobalChat.tsx:247-320`).

## Truthfulness Notes

Code-proven:

- Local tracking and persisted timeline reconstruction.
- Persistent AI threads and local artifacts on desktop.
- Main-process AI orchestration with provider/model routing and usage telemetry.
- Workspace linking, recovery words, browser link codes, heartbeat, and day sync packaging.

Implemented pending verification:

- Provider-backed AI flows in real user/runtime conditions across all supported providers.
- Packaged runtime behavior across macOS, Windows, and Linux.
- Linked multi-device remote freshness, stale-state UX, and failure recovery in normal use.
- Week review, app narrative, report/export generation, and remote companion production behavior.

Still partial or intentionally limited:

- Structured entity rollups in snapshot export currently load `client` and `project` only, even though the shared remote contract also allows `repo` and `topic` kinds (`src/main/services/snapshotExporter.ts:279-321`, `packages/remote-contract/index.ts:153-159`).
- Desktop does not yet sync shared cloud AI thread/message/artifact rows. The contract has workspace AI types, and local desktop thread metadata already carries `workspaceThreadId`, but cross-surface desktop-to-web AI continuity is still not implemented (`src/main/services/artifacts.ts:339-342`, `packages/remote-contract/index.ts:287-318`).
- The web still carries both the new `remoteSync` truth-table path and a legacy `snapshots` path. `/api/snapshots?full=1` still calls the legacy snapshot list endpoint (`/Users/tonny/Dev-Personal/daylens-web/app/api/snapshots/route.ts:35-40`, `/Users/tonny/Dev-Personal/daylens-web/convex/snapshots.ts:88-231`).

## Development

- `npm start` runs the Electron app in development mode.
- `npm run typecheck` checks TypeScript without emitting output.
- `npm run build:all` builds main, preload, and renderer bundles.
- `npm run contract:check` validates the shared remote contract wiring.
- `npm run test:ai-chat` runs the main desktop AI/chat regression suite.
- `npm run test:entity-prompts` runs the prompt-routing benchmark harness.
- `npm run dist:mac`, `npm run dist:win`, `npm run dist:linux` build release artifacts.

## Canonical Docs

- [docs/AGENTS.md](docs/AGENTS.md): product and build contract
- [docs/ISSUES.md](docs/ISSUES.md): current implementation status, known gaps, and validation needs
- [docs/PRD.md](docs/PRD.md): remote companion product definition refreshed from code
- [docs/SRS.md](docs/SRS.md): current desktop + remote system architecture
- [docs/REMOTE_CONTRACT.md](docs/REMOTE_CONTRACT.md): shared sync and remote AI continuity contract
- [docs/REMOTE_PARITY_MATRIX.md](docs/REMOTE_PARITY_MATRIX.md): desktop vs. remote status matrix
- [docs/REMOTE_EXECUTION_PLAN.md](docs/REMOTE_EXECUTION_PLAN.md): next implementation sequence after the audit
- [docs/ai-orchestration.md](docs/ai-orchestration.md): main-process AI routing and persistence model
- [docs/IDEAS.md](docs/IDEAS.md): future work only
