# Workstream UX — Ship-readiness pass

## Files changed
- `src/renderer/views/Timeline.tsx` — inspector columns (`DaySummaryInspector`, `BlockInspector`) now have `maxHeight: calc(100vh - 140px)` + `overflowY: auto` alongside `position: sticky`, so the right-hand context/evidence card scrolls independently; label override form simplified to a single input + `Save` (+ `Reset` when an override exists) with an `sr-only` label.
- `src/renderer/views/Settings.tsx` — added `ANTHROPIC_MODEL_OPTIONS` / `OPENAI_MODEL_OPTIONS` lists (mirroring canonical ids from `aiOrchestration.ts`), added Anthropic and OpenAI model `Select`s inside the existing advanced AI controls, and tightened copy across Tracking, Sync, AI, Labels, Notifications, Appearance, Updates, and Privacy sections. Removed the decorative page subtitle. Kept the Update button untouched.

## Behavior changes
- Timeline right column scrolls inside its own container; users no longer have to scroll past the full day timeline to reach the bottom of evidence/insight cards.
- Block label override form is now one input + one primary button (+ `Reset` when overridden); no paragraph help text.
- Settings AI advanced section now exposes `Anthropic model` and `OpenAI model` selects that persist via the existing `ipc.settings.set` path (`anthropicModel` / `openaiModel` fields already in `AppSettings`; `settings.handlers.ts` already invalidates projections on those keys).
- Model selects are always rendered inside the advanced AI block (hidden behind the existing "Show advanced AI controls" toggle). Chose always-visible-when-advanced rather than conditional-on-strategy=custom because: (a) it avoids UI flicker when switching strategies, (b) the row description plainly states "Applied when strategy is Custom" so the behavior is honest, and (c) the advanced toggle already gates this from the default settings surface.
- Across Settings: section descriptions and row descriptions are meaningfully shorter; no real controls were removed; the Updates section and its `Check for updates` / `Restart to install` buttons are intact.

## Status claims
- Timeline inspector scroll: implemented pending verification (needs eye-check on very tall inspector content across window heights).
- Label override simplification: implemented pending verification.
- Model selector in Settings: implemented pending verification (persistence path reuses existing generic `SETTINGS.SET` handler; no new IPC route added).
- Settings copy cleanup: implemented pending verification.

## Repo override UI (Task 2)
Grepped `src/renderer` for `repo`, `repository`, `override`, `workstream`, `Save Repo`, etc. The only repo-related renderer hit is an icon fallback in `EntityIcon.tsx`. There is no standalone repo-override form in `Timeline.tsx` or any nested component today. Interpreted the closest match — the verbose block Label Override form — as the target and simplified it aggressively. If a distinct repo-attribution form is expected, it is not currently rendered anywhere in `src/renderer`.

## Week view
Not touched. No low-risk one-line improvement surfaced.

## Typecheck
```
> daylens-windows@1.0.26 typecheck
> tsc --noEmit

src/main/lib/focusScore.ts(2,28): error TS6196: 'FocusScoreBreakdown' is declared but never used.
```
Pre-existing, unrelated to this workstream.

## Pre-existing issues noticed, left alone
- `src/main/lib/focusScore.ts:2` — unused `FocusScoreBreakdown` import (TS6196).
- `Timeline.tsx` uses inline style objects extensively; no CSS-module layer — fine for this pass but worth a broader refactor pass eventually.
- `Settings.tsx` `SettingsSection` left column has `flex: 0 0 188px` but description text can still wrap awkwardly on narrow windows; out of scope here.
