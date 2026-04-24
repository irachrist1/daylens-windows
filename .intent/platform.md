# Workstream Platform / Audit — Ship-readiness pass

The Platform sub-agent hit its rate limit mid-run. The code it produced compiles, typechecks, and passes tests. The parent session inspected the diffs and filled gaps it had not reached; this file records the final merged state.

## Files changed
- `src/shared/types.ts` — added `FocusScoreBreakdown` type (coherence / deepWork / artifactProgress / switchPenalty / score).
- `src/main/lib/focusScore.ts` — added `computeFocusScoreV2(input)` implementing the locked V2 heuristic below. Old `computeFocusScore` retained so any legacy call sites stay stable; new consumers should prefer V2.
- `src/main/services/snapshotExporter.ts` — rewired to `computeFocusScoreV2`; derives blocks from `getTimelineDayPayload` so scoring reflects real work boundaries, counts unique artifact IDs (topArtifacts + pageRefs + documentRefs) for `uniqueArtifactCount`, and falls back to unique window-title count when artifact signal is absent.
- `src/main/ipc/focus.handlers.ts` — emits `focus_session_started` / `focus_session_stopped` analytics with `duration_bucket` + numeric `duration_sec` on stop. Uses `getActiveFocusSession` to derive duration at stop time.
- `src/main/services/updater.ts` — explicit `darwin` branch in `getAutoUpdateSupport` so the renderer sees `supported: true` with an honest null message on macOS (Linux package-type gating was already present).
- `src/shared/analytics.ts` — registered six new event names (`FOCUS_SESSION_STARTED`, `FOCUS_SESSION_STOPPED`, `ARTIFACT_CREATED`, `AI_THREAD_CREATED`, `AI_THREAD_ARCHIVED`, `AI_THREAD_DELETED`); added safe keys (`duration_bucket`, `artifact_kind`, `byte_size_bucket`, `thread_action`, `duration_sec`, `target_minutes`); added `focusDurationBucket` + `byteSizeBucket` helpers. All event payloads still go through the existing PII scrubber — only pre-registered safe keys pass through.
- `src/renderer/views/Apps.tsx` — narrative staleness guard: only render a narrative whose `scopeKey` matches the currently selected app/range, eliminating a brief stale-narrative flash when switching apps.
- `tests/focusScoreV2.test.ts` *(new)* — 5 tests covering coherence, deep-work rewards, switch-rate penalty, window-title fallback, and artifact-count clamping.

## Focus score V2 — locked heuristic

```
focus_score = clamp01(
  0.35 * session_coherence
  + 0.25 * deep_work_density
  + 0.20 * artifact_progress
  + 0.20 * (1 - switch_penalty_normalized)
) * 100
```

- `session_coherence = weighted_mean_block_duration_min / 45` (active-seconds-weighted, clamped).
- `deep_work_density = seconds_in_blocks_≥25min / total_active_seconds`.
- `artifact_progress = log2(1 + unique_artifacts) / log2(1 + 16)`; graceful fallback to `min(1, unique_window_titles / 10)` when artifact signal is absent — honest default, never zero-stuffed.
- `switch_penalty_normalized = min(1, switches_per_hour / 20)`. Demoted to 20 % weight.
- Returns both the score and a `{coherence, deepWork, artifactProgress, switchPenalty}` breakdown for UI / export transparency.

## Updater audit
- `electron-updater` is wired for macOS, Windows, and Linux AppImage.
- macOS: now explicit `supported: true` with `latest-mac.yml` path (electron-updater still requires a signed app for Squirrel to swap in the update on relaunch, but progress/download/downloaded states flow regardless).
- Windows: NSIS target; auto-update via `latest.yml` works on signed and unsigned installers (unsigned still triggers SmartScreen — tracked in `ISSUES.md`).
- Linux: AppImage auto-updates when `process.env.APPIMAGE` is set; deb/rpm/tar.gz correctly fall through to a "Update via your package manager" state with `supported: false` + a package-type-specific message (already present pre-pass; verified intact).
- UpdateBanner, Settings "Check for updates", and "Restart to install" preserved.
- **Still needs validation on a real packaged install for each platform.**

## Analytics audit — PII safety
- All event payloads flow through the existing allow-list scrubber in `src/shared/analytics.ts`. Raw prompts, response text, file paths, URLs, and window titles are never passed to `capture()` call sites; the new event emitters only pass categorized values (kind, bucket, duration_sec, target_minutes, null|boolean flags).
- Opt-out is respected at the `capture()` boundary (gated on `analyticsEnabled` in settings via existing pathway).
- Device ID remains an opaque UUID stored in settings; no emails or names.

## Final event inventory (post-pass)
- Existing: `ai_query_answered`, `ai_answer_copied`, `ai_answer_retried`, `ai_job_started`, `ai_job_completed`, `ai_job_failed`, `feedback_submitted`, `settings_changed`, `update_check_requested`, `update_downloaded`, `update_installed`, `update_failed`, plus all onboarding / screen-view events.
- New in this pass: `focus_session_started`, `focus_session_stopped`, `artifact_created`, `ai_thread_created`, `ai_thread_archived`, `ai_thread_deleted`. Of these, `focus_session_*` and `artifact_created` are now wired at emit sites; the thread-action events are declared and scrubber-safe but not yet wired to `createThread` / `archiveThread` / `deleteThread` (one-liner follow-up).

## Rename/reset truthfulness verdict
- Backend path: `IPC.DB.SET_BLOCK_LABEL_OVERRIDE` + `IPC.DB.CLEAR_BLOCK_LABEL_OVERRIDE` are wired in `db.handlers.ts` with `workBlocks` invalidation. Preload exposes both. Timeline's `BlockInspector` (post-UX simplification) calls them via the single-input + Save/Reset form.
- Code appears to work end-to-end. The remaining gap is **human validation of the actual typing/submit flow** — automation could not drive the text field in the prior pass. Status upgrade: the code path is no longer just "UI rendered"; Save/Reset is now a straightforward single-input form that should be easy to validate manually.

## Verified automatically
- `npm run typecheck` — clean (pre-existing `FocusScoreBreakdown` unused warning was resolved when the V2 function adopted the type).
- `tests/focusScoreV2.test.ts` — 5/5 pass.
- Full `npm run test:ai-chat` suite — 30/30 pass.
- `npm run build:all` — clean.

## Still needs manual validation
- Packaged-install auto-update on macOS / Windows / Linux AppImage.
- Linux deb/rpm/tar.gz graceful degradation text on a real install.
- Rename/reset end-to-end typing/submit in the simplified Timeline form.
- PostHog dashboard: confirm the new event names flow in and render.

## Left open for a follow-up pass
- Wire `ai_thread_created` / `_archived` / `_deleted` at the three thread-mutation sites in `artifacts.ts`.
- Focus-session artifact auto-write on session start/stop/review (kind=`focus_session`).
