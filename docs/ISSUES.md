# Issues

Status last updated 2026-05-01 (post-v1.0.35 macOS/Linux publication, plus Windows Store packaging lane for a Microsoft-signed no-danger-screen path). Prior audit: 2026-04-30.

This file is the implementation-status ledger. Items below are separated into code-proven, `implemented pending verification`, and still-partial/open. Older docs and summaries were treated as hypotheses during this refresh.

## Code-Proven Today

### Desktop Tracking And Persistence

- Foreground tracking persists real sessions to SQLite and recovers a persisted live-session snapshot after restart (`src/main/services/tracking.ts:981-1071`, `src/main/services/tracking.ts:1395-1470`).
- Linux tracking diagnostics explicitly report `ready`, `limited`, or `unsupported` depending on session/backend availability (`src/main/services/tracking.ts:196-299`).
- Foreground tracking filters Daylens self-capture and Daylens project-title sessions before persistence, so Daylens debugging windows do not become user work evidence (`src/main/services/tracking.ts`, `tests/trackingSelfCapture.test.ts`).
- Timeline day payloads are rebuilt from persisted sessions plus the live session, not renderer memory (`src/main/services/workBlocks.ts:1849-1880`).
- Timeline blocks, members, labels, artifact mentions, and workflow occurrences are persisted in dedicated tables (`src/main/services/workBlocks.ts:1438-1607`).
- Timeline block splitting now preserves same-app window-title changes, splits sustained content-context shifts after 5 minutes, caps deterministic blocks at 60 minutes, and prefers deterministic title/artifact labels over stale AI or raw app labels (`src/main/db/queries.ts`, `src/main/services/workBlocks.ts`, `tests/workBlockSplitting.test.ts`).

### Timeline Surface

- Desktop Timeline has day/week modes, explicit gap rendering, block inspection, and a week-review slot (`src/renderer/views/Timeline.tsx:834-1182`, `src/renderer/views/Timeline.tsx:1184-1545`).
- Empty-state copy is truthful about relying on persisted local activity (`src/renderer/views/Timeline.tsx:1478-1491`).
- The right-side day summary and block inspectors stay sticky and hide their own scrollbars while remaining scrollable when content overflows, so the visible nested scrollbar no longer fights the timeline list scroll (`src/renderer/views/Timeline.tsx`, `src/renderer/styles/globals.css`).
- Timeline day and week surfaces now avoid focus-percentage copy and emphasize tracked time, blocks, active days, artifacts, and categories instead (`src/renderer/views/Timeline.tsx`, `tests/focusMetricCopy.test.ts`).

### Apps Surface

- Desktop Apps merges live-session time into summaries and loads contextual app detail plus app narrative (`src/renderer/views/Apps.tsx:36-73`, `src/renderer/views/Apps.tsx:144-245`).
- Desktop Apps now defaults to today, deduplicates category labels, filters app-name-only block appearances, separates files/documents from pages, and keeps app detail focused on what the tool helped with rather than vanity totals (`src/renderer/views/Apps.tsx`, `src/main/services/workBlocks.ts`, `tests/appDetailPayload.test.ts`).

### AI Surface

- Desktop AI supports starter prompts, freeform chat, deterministic routing before LLM fallback, streaming, retry/copy/rating controls, focus-session actions, persistent local threads, queryable message ratings, and local artifacts (`src/main/services/ai.ts:3715-3993`, `src/main/db/aiThreadSchema.ts:23-63`, `src/main/db/queries.ts:1320-1374`, `src/main/services/artifacts.ts:24-170`, `src/main/services/artifacts.ts:261-408`, `src/renderer/views/Insights.tsx:787-804`, `src/renderer/views/Insights.tsx:957-965`, `src/renderer/views/Insights.tsx:1083-1372`, `src/renderer/views/Insights.tsx:1608-1715`).
- AI orchestration is centralized in the main process with per-job routing, provider fallback, prompt redaction, and usage telemetry (`src/main/services/aiOrchestration.ts:54-185`, `src/main/services/aiOrchestration.ts:245-474`).
- The MCP server is bundled in this repo under `packages/mcp-server/` and exposed from Settings as an opt-in local stdio integration for MCP clients. It reuses the AI tool schemas and opens the local Daylens SQLite database read-only (`packages/mcp-server/src/index.ts:1-67`, `src/main/services/mcpServer.ts:19-57`, `src/renderer/views/Settings.tsx:1348-1428`).
- Follow-up suggestion chips are validated through a two-stage filter: deterministic candidates use a grammar-word stop list to reject garbage router topics, and Haiku-generated candidates must name a real entity from the answer text (`src/main/lib/followUpSuggestions.ts`).
- Conversation history is sanitized before being sent to the provider: user+assistant pairs where the assistant content is empty are stripped to prevent providers from returning empty responses on follow-up turns (`src/main/services/ai.ts:sanitizeConversationHistory`).
- Files tab auto-refreshes after every completed turn using a dedicated `artifactsVersion` counter, and auto-switches to the Files view when a turn produces artifacts (`src/renderer/views/Insights.tsx:~1026,~1163`).
- Thread titles no longer echo single-word greetings: `deriveTitleFromMessage` returns `"New chat"` for greeting messages and the first substantive message renames the thread synchronously before `listThreads` is called (`src/main/lib/threadTitles.ts`, `src/main/services/ai.ts:4152`).
- Thinking… indicator is guarded against re-appearing once streaming content has started, using a message-ID ref set populated by the stream handler (`src/renderer/views/Insights.tsx:streamedContentIdsRef`).
- The "Which files, docs, or pages did I touch today?" prompt shape now routes to local evidence first and answers from artifacts, page titles, window titles, and apps instead of returning a filename-token fallback (`src/main/lib/insightsQueryRouter.ts`, `tests/touchedEvidenceRouter.test.ts`, `tests/shouldUseRouter.test.ts`).
- Day summary parsing refuses malformed raw JSON-looking model output instead of rendering `{ "summary": ... }` in the Timeline, and the deterministic fallback now uses more cautious evidence wording when intent is low-confidence (`src/main/lib/daySummarySuggestions.ts`, `src/main/services/ai.ts`, `tests/followUpChat.test.ts`).
- AI prompts for daily summaries, week reviews, app narratives, generated reports, router prose, and provider-backed chat now prohibit raw app names as activity nouns, keeping answers focused on work threads, artifacts, pages, and context (`src/main/services/ai.ts`, `tests/aiPromptPolicy.test.ts`).
- Thread follow-up routing restores conversation state from the active AI thread instead of leaking context across local threads (`src/main/services/ai.ts`, `src/main/db/queries.ts`, `tests/followUpChat.test.ts`).
- Follow-up suggestion parsing now rejects temporal words such as Today, Yesterday, Monday, Morning, and Evening when they appear in the entity slot (`src/main/lib/followUpSuggestions.ts`, `tests/followUpSuggestions.test.ts`).
- Microsoft 365 aliases and fallback icon tiles are normalized for Excel, Word, PowerPoint, Outlook, and Teams so renderer app rows, block app lists, and artifact tiles use consistent branded fallback icons when native icons are unavailable (`shared/app-normalization.v1.json`, `src/renderer/lib/apps.ts`, `src/renderer/components/AppIcon.tsx`, `src/renderer/components/EntityIcon.tsx`, `tests/appIdentityBranding.test.ts`).
- WhatsApp, GitHub, ChatGPT, OneDrive, LinkedIn, and FaceTime aliases preserve their marketed display names across canonical app resolution and renderer fallback formatting (`shared/app-normalization.v1.json`, `src/renderer/lib/apps.ts`, `tests/appIdentityBranding.test.ts`).

### Settings And Sync Controls

- Desktop Settings already exposes workspace linking, browser link creation, recovery words, sync-state display, provider routing, prompt caching, redaction toggles, category overrides, and Linux diagnostics (`src/renderer/views/Settings.tsx:824-999`, `src/renderer/views/Settings.tsx:1000-1334`).
- Sync status is derived from durable sync outcome plus heartbeat freshness. A newer durable failure still wins over a fresh heartbeat (`src/main/services/syncState.ts:5-24`, `tests/syncStatus.test.ts`).
- Desktop macOS/Windows update checks use the public Daylens update feed instead of anonymous GitHub release discovery, and legacy GitHub updater failures are normalized to concise manual-download guidance instead of raw response headers (`src/main/services/updater.ts:288-403`, `src/shared/updaterReleaseFeed.ts:66-94`, `tests/updaterReleaseFeed.test.ts`).
- Workspace sync failures shown in Settings are sanitized into short user-facing guidance such as "Workspace link expired. Reconnect this device." while raw server details remain out of the main UI (`src/shared/syncMessages.ts`, `src/renderer/views/Settings.tsx`, `tests/syncMessages.test.ts`).
- Update downloads no longer initialize the banner at a fake `0%`; progress stays unknown until progress is measurable, then reports bounded 1-99% download progress before the install-ready state (`src/main/services/updater.ts`, `src/shared/updaterReleaseFeed.ts`, `tests/updaterReleaseFeed.test.ts`).
- Update banner highlights now ignore internal release-body sections and implementation jargon, returning at most two short user-facing highlights (`src/renderer/lib/releaseNotes.ts`, `tests/releaseNotes.test.ts`).
- Daily summary and Morning Brief notification routes now include the target report date, show/focus a hidden app window before navigation, and open Day Wrapped for that date even when the local day payload is empty (`src/main/services/dailySummaryNavigation.ts`, `src/main/services/dailySummaryNotifier.ts`, `src/renderer/lib/dailySummaryNavigation.ts`, `src/renderer/App.tsx`, `tests/notificationNavigation.test.ts`).
- The paired public update/download routes in `daylens-web` now refuse Windows `.exe` assets below the signed release floor; a live production check on 2026-04-30 returned `404` with "No signed Windows update is available right now" for `platform=win32&arch=x64` (`/Users/tonny/Dev-Personal/daylens-web/app/api/update-feed/route.ts`, `/Users/tonny/Dev-Personal/daylens-web/app/api/download/windows/route.ts`, `/Users/tonny/Dev-Personal/daylens-web/app/api/download/_releaseAsset.ts`).
- v1.0.35 is published for macOS and Linux with GitHub release assets and updater metadata. The release contains `Daylens-1.0.35-arm64.dmg`, `Daylens-1.0.35-arm64.zip`, `latest-mac.yml`, `Daylens-1.0.35.AppImage`, `Daylens-1.0.35.deb`, `Daylens-1.0.35.rpm`, `Daylens-1.0.35.tar.gz`, and `latest-linux.yml`. No Windows v1.0.35 installer was published because signing secrets were not visible locally and public Windows installers must be signed.
- A Windows Store package lane now exists for the no-danger-screen Windows path: `npm run dist:win:store` builds the AppX target, and `.github/workflows/release-windows-store.yml` packages a Partner Center identity-specific Store submission artifact on `windows-latest`. This is code-proven as configuration only until a real Partner Center app identity is provided and the workflow succeeds.

### Remote Foundation

- The shared remote contract package exists and is used across repos (`packages/remote-contract/index.ts:1-318`, `src/shared/snapshot.ts:1`, `tests/remoteContractCheck.test.ts`).
- Desktop remote payload shaping strips block artifact refs and rewrites page labels to privacy-safe domain labels (`src/main/services/remoteSync.ts:43-69`, `src/main/services/remoteSync.ts:192-227`, `tests/remoteSyncPayload.test.ts`).
- `daylens-web` already exposes `Timeline`, `Apps`, `AI`, and `Settings` navigation (`/Users/tonny/Dev-Personal/daylens-web/app/components/AppChrome.tsx:58-165`).
- Web session reads are scoped to `sessionKind === "web"` (`/Users/tonny/Dev-Personal/daylens-web/app/lib/session.ts:15-41`).

## Implemented Pending Verification

These features exist in code and, in several cases, have focused test coverage, but this audit did not re-prove them end-to-end in real runtime use.

- Provider-backed chat quality and failure handling across supported desktop AI providers.
- Default-on redacted AI feedback example sharing is implemented in desktop code and the paired `daylens-web` Convex backend, but live deployed ingest and admin export have not been verified (`src/main/services/aiFeedbackUpload.ts`, `/Users/tonny/Dev-Personal/daylens-web/convex/aiFeedback.ts`, `/Users/tonny/Dev-Personal/daylens-web/convex/http.ts`).
- Week review and app narrative usefulness in live user conditions (`src/main/services/aiOrchestration.ts:91-108`, `src/renderer/views/Timeline.tsx:886-890`, `src/renderer/views/Apps.tsx:217-245`).
- Report/export artifact generation and downstream open/share flows on packaged apps (Files tab refresh fix ships in v1.0.33 — still needs packaged validation).
- Follow-up suggestion chip quality across varied response types and providers (Haiku prompt rewrite ships in v1.0.33 — needs live validation).
- Focus-session start/stop/review flows from AI messages in normal usage (`src/renderer/views/Insights.tsx:1229-1282`).
- Linked remote freshness, stale-state UX, and session-repair behavior under real multi-device use (`src/main/services/syncUploader.ts:232-284`).
- Packaged runtime validation across macOS, Windows, and Linux.
- End-to-end updater recovery from older installed builds. The v1.0.35 macOS update feed now returns v1.0.35 and the candidate code path avoids fake `0%` progress, but this audit did not prove an older packaged macOS app successfully downloads, installs, and relaunches into the new build. Windows still has no signed v1.0.35 installer.
- Windows Store packaging and Microsoft Store certification. The Store lane exists in code, but it still needs a real Partner Center package identity, a successful `release-windows-store.yml` run, Store submission, Microsoft certification, and publication before it is a real user-installable Windows path.

## Still Partial Or Open

### Windows Signing And SmartScreen

- v1.0.33 and earlier Windows installers were published unsigned because `release-windows.yml` allowed empty signing secrets and electron-builder skipped signing. The workflow now fails without signing credentials and verifies Authenticode signatures before upload (`.github/workflows/release-windows.yml`). The next Windows release still requires a trusted certificate to be added as GitHub Actions secrets before it can publish.
- The v1.0.34 public GitHub release currently has no Windows installer asset because the signed-release gate withheld unsigned Windows output. Before the web-gate pass, the live Windows update feed selected the old unsigned v1.0.33 installer because it was the newest Windows `.exe` asset. The production feed now refuses Windows assets below the signed-release floor (`1.0.35` by default) and returns 404 until a signed v1.0.35+ Windows installer exists.
- Even after Authenticode signing, brand-new Windows installer file hashes can still show SmartScreen reputation warnings until Microsoft reputation accumulates. This is a distribution trust/reputation issue, not evidence that the packaged app contains malware.
- Microsoft Store distribution is the no-danger-screen path that does not require a purchased Authenticode certificate. Store-submitted AppX/MSIX packages are signed by Microsoft during certification; the pre-certification workflow artifact must not be served directly to users.

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

- This audit inspected code and tests, ran local desktop build/test checks, verified CI macOS packaging, verified CI Linux release packaging and AppImage/DEB/RPM smoke tests, checked the live macOS update feed, and checked that the live Windows update feed safely returns 404 without a signed Windows asset. It did not run a real installed-app update, a real macOS app launch from the published DMG/ZIP, real Windows packaged validation, real linked-workspace remote validation, or full provider-backed AI validation across platforms.

## Tests That Support Current Behavior

- `tests/browserDiscovery.test.ts`: browser discovery behavior and diagnostics.
- `tests/remoteSyncPayload.test.ts`: privacy-filtered remote sync shaping.
- `tests/focusScoreV2.test.ts`: focus score V2 behavior.
- `tests/recap.test.ts` and `tests/recap.stress.test.ts`: recap truthfulness rules.
- `tests/analytics.test.ts` and `tests/analytics.service.test.ts`: telemetry sanitization and opt-in behavior.
- `tests/followUpChat.test.ts`, `tests/aiThreadSchema.test.ts`, `tests/aiThreadDeletion.test.ts`: AI follow-up, thread schema, and deletion behavior.
- `tests/syncStatus.test.ts`: sync-state derivation logic.
- `tests/blockCleanup.test.ts`: selective cleanup/relabel behavior.
- `tests/updaterReleaseFeed.test.ts`, `tests/releaseNotes.test.ts`, `tests/syncMessages.test.ts`, `tests/touchedEvidenceRouter.test.ts`, and `tests/appIdentityBranding.test.ts`: release-quality regressions for updater progress, visible update notes, sync-error sanitization, touched-evidence answers, and Microsoft 365 icon normalization.
- `tests/workBlockSplitting.test.ts`, `tests/trackingSelfCapture.test.ts`, `tests/notificationNavigation.test.ts`, `tests/appDetailPayload.test.ts`, `tests/focusMetricCopy.test.ts`, `tests/aiPromptPolicy.test.ts`, and `tests/followUpSuggestions.test.ts`: v1.0.35 regressions for self-capture filtering, timeline block splits, daily-notification navigation, app-detail context, focus-copy removal, AI prompt policy, and follow-up suggestion filtering.

## Real Runtime Or User Verification Still Needed

- Windows packaged runtime validation on a real machine.
- Windows Authenticode-signed release validation on a real machine after signing secrets are added.
- Windows Store package build validation after Partner Center identity values are available.
- Microsoft Store certification and publication for the no-danger-screen Windows install path.
- Confirm the production Windows update feed returns a signed v1.0.35+ installer after Windows signing secrets are added and a signed Windows release is published.
- macOS in-app update validation from an older installed build to the newly published v1.0.35 public-feed build.
- Windows in-app update validation after a signed v1.0.35+ Windows installer exists.
- Linux packaged runtime validation on real desktops, including X11 and Wayland/XWayland scenarios.
- End-to-end linked workspace creation, browser linking, heartbeat/day-sync freshness, and stale/failure recovery in normal use.
- Desktop provider-backed AI chat, report generation, and focus-session action flows with real credentials.
- MCP client setup and real question/answer validation through Claude Desktop, Cursor, or Claude Code.
- Desktop-to-web AI continuity after the shared remote AI persistence is actually implemented.
