# Workstream AI/Artifacts — Ship-readiness pass

The AI/Artifacts sub-agent hit its rate limit mid-run; the backend it produced was complete and typechecked, so the parent session finished the renderer surface and the preload bridge. This file records the final, merged state.

## Files changed
- `src/shared/types.ts` — new types: `AIArtifactKind`, `AIArtifactRecord`, `AIArtifactContent`, `AIThreadSummary`; `AIChatSendRequest.threadId`; `FocusScoreBreakdown` (used by Platform workstream); new `IPC.AI` channels for threads + artifacts (10 new channels).
- `src/main/db/schema.ts` — added `ai_threads`, `ai_artifacts` tables + indexes; `ai_messages.thread_id` column + `idx_ai_messages_thread` index (so fresh DBs and test DBs match the migrated shape).
- `src/main/db/migrations.ts` — migration `v19`: creates both tables, adds `thread_id` to `ai_messages` if missing, backfills one "Imported chat" thread per existing `conversation_id` so legacy rows are never orphaned.
- `src/main/db/queries.ts` — `appendConversationMessage` now accepts `threadId`; new `getThreadMessages` selects by `thread_id`.
- `src/main/services/artifacts.ts` *(new)* — full CRUD + `openArtifact` / `exportArtifact`. Binary/large artifacts (>32 KB) land in `userData/artifacts/<stamp>-<slug>.<ext>`; small ones stored inline. Thread helpers: `listThreadsLite`, `createThread`, `renameThread`, `archiveThread`, `deleteThread`, `ensureDefaultThread`, `touchThreadLastMessage`, `deriveTitleFromMessage`. Emits `artifact_created` analytics with `kind` + `byte_size_bucket`; never blocks persistence on telemetry.
- `src/main/services/ai.ts` — `sendMessage` accepts `threadId`; auto-creates a thread titled from the first user message when absent; `persistChatTurn` stamps rows with the thread, touches `last_message_at`, and writes one `ai_artifacts` row per `AIMessageArtifact` emitted by the orchestrator (mapped to `markdown` / `csv` / `json_table` / `html_chart` / `report`).
- `src/main/ipc/ai.handlers.ts` — 10 new handlers: `LIST_THREADS`, `GET_THREAD`, `CREATE_THREAD`, `ARCHIVE_THREAD`, `RENAME_THREAD`, `DELETE_THREAD`, `LIST_ARTIFACTS`, `GET_ARTIFACT`, `OPEN_ARTIFACT`, `EXPORT_ARTIFACT`. `GET_HISTORY` now thread-aware.
- `src/preload/index.ts` — exposes all new channels on `ipc.ai.*`.
- `src/renderer/views/Insights.tsx` — adds thread switcher (dropdown of recent threads + "New chat" that creates a new thread rather than clearing history), artifacts strip below the message log (Preview / Open / Export per artifact), and an inline preview panel (markdown/CSV/JSON as `<pre>`; HTML chart inside a sandboxed `<iframe srcDoc>`). Active `threadId` is passed to `sendMessage`; if absent, the renderer refreshes `listThreads()` after the first turn and adopts the newest row.

## Architecture decisions (locked in at plan time, honored)
- DB rows + files under `userData/artifacts/`.
- Preview/Open/Export inside the existing AI surface; no new top-level tab.
- Linkage is `ai_threads.id` ↔ `ai_messages.thread_id` ↔ `ai_artifacts.thread_id` + `ai_artifacts.message_id`.
- No Vercel AI SDK, no Vercel Sandbox. Electron + SQLite + local files is the persistence layer; adding the SDK would duplicate what we already have and Sandbox is web-first.

## Grounding / truthfulness
The backend agent stopped before sweeping `ai.ts` for eager-mock paths and template-canning. The durable artifact pipeline (`persistMessageArtifacts`) is in place, and all chart/table/report artifacts the orchestrator already emits are now written to disk as `ai_artifacts` rows, visible in the artifacts strip, openable via `shell.openPath`, and exportable via `dialog.showSaveDialog`. That surfaces evidence quality directly in the UI — mocky or stubby output becomes visible as same-y artifacts the user can inspect. **Prompt-template and eager-fallback audit inside `ai.ts` remains open.**

## Status claims
- Threads persistence and thread switcher: implemented pending verification (needs a real multi-turn run against a provider to exercise the adopt-newest-thread-on-first-send path end-to-end).
- Artifacts persistence + preview + open + export: implemented pending verification (needs a real report/chart generation pass to exercise the full round-trip; unit-level DB write + read + open/export IPC wiring all typecheck and build clean).
- Grounding / prompt-template / eager-mock audit across `ai.ts`: NOT complete in this pass. The surface area is 3.8k LOC; the agent did not reach it before hitting the limit. Left for a follow-up pass.
- Focus session ↔ artifact linkage: deferred to a follow-up pass (focus artifacts are only auto-created when the orchestrator already emits an `AIMessageArtifact` for them; a dedicated `focus_session` artifact write on start/stop is not yet wired).

## Verified automatically
- `npm run typecheck` — clean.
- `npm run build:all` — main + preload + renderer bundles build successfully.
- `npm run test:ai-chat` — 30/30 pass (includes `conversation state persists alongside structured AI messages`, which exercises the new `thread_id` column).
