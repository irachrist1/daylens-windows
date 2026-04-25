# Changelog

## v1.0.32 - 2026-04-25

### Fixed
- Windows startup no longer fails with a main-process JavaScript error when `better-sqlite3` resolves through `app.asar.unpacked`; packaged builds now repair and verify the native module layout before release.
- Windows release builds now run the same full `build:all` path as macOS and Linux, including the bundled MCP server.
- Remote sync now accepts the current `focusScoreV2` contract on the web/Convex side, so linked devices can resume durable day sync instead of repeating `Remote day sync failed`.

### Changed
- Release packaging now includes an opt-in local MCP stdio server bundle and records its pending real-client validation honestly in the docs.
- Existing installs can reach update assets through the public website feed/proxy, while legacy GitHub-feed builds are recoverable once the GitHub release feed is publicly reachable.

## v1.0.31 - 2026-04-24

### Added
- **Full-text search across your entire history** — type any word into the new search box in the AI view and get every matching app session, work block, browser page, and AI artifact, sorted by time with highlighted excerpts. No AI involved — pure local SQLite FTS5.
- **Your name in Daylens** — set a display name in onboarding or Settings and the AI will use it in every response instead of the generic fallback.
- **Goals now shape your AI context** — picking "less distractions" during onboarding adds a live distraction summary (minutes + top domains) to every AI response. Picking "deep work" adds your deep-work percentage and longest streak.

### Changed
- **Honest focus score** — the old formula returned ~20 even on idle days. The new score is a single percentage: time in focused deep-work sessions (25+ continuous minutes) divided by total active time. Returns "Not enough data" instead of a fake number when you haven't tracked enough yet.
- Thread deletion now removes attached artifact files from disk instead of only cleaning the database row.
- Creating a new chat reuses an existing empty thread instead of accumulating blank drafts.

## v1.0.30 - 2026-04-23

### Fixed
- macOS updates now avoid the broken Squirrel.Mac install path on ad-hoc signed builds by downloading the release ZIP directly, swapping the app bundle in place, and relaunching
- Release notes now strip HTML tags cleanly so GitHub-rendered changelog text no longer leaks raw markup into the update banner

## v1.0.29 - 2026-04-20

### Changed
- Rewrote the in-DMG `Start Here.txt` (formerly `If Daylens is "damaged" - READ ME.txt`) for non-technical users: action-first three-step install, visual mockup of the first-launch Gatekeeper prompt, numbered Open Anyway steps, and Homebrew shown as an optional shortcut rather than the fallback
- `docs/INSTALL.md` leads with the current first-launch flow (the "Not Opened" Gatekeeper prompt that appears after the v1.0.28 ad-hoc re-sign), and demotes the legacy "damaged" dialog fix to a troubleshooting section for anyone still on an older DMG

## v1.0.28 - 2026-04-20

### Fixed
- macOS DMG no longer triggers the "Daylens is damaged and can't be opened" dialog on Finder double-click: the release pipeline now re-signs the bundle ad-hoc with `codesign --force --deep --sign -` in an `afterSign` hook, producing a complete signature with sealed resources that Gatekeeper can verify
- Release workflow auto-detects whether Developer ID credentials are present; without them it builds an ad-hoc signed DMG instead of failing the "Require signing and notarization credentials" gate

### Added
- `docs/INSTALL.md` with Homebrew, manual DMG, Windows, and Linux instructions plus the one-line `codesign` + `xattr` fix for users on older builds
- Homebrew tap at `irachrist1/homebrew-daylens` so users can `brew install --cask irachrist1/daylens/daylens` and skip the Gatekeeper dance entirely
- `build/dmg-README.txt` ships inside the mounted DMG so manual-DMG users who never read GitHub still see the fix

## v1.0.27 - 2026-04-19

### Added
- Snapshot v2 exports now include recap summaries, focus score v2 breakdowns, work blocks, standout artifacts, entity rollups, and Linux as a first-class snapshot platform for downstream Daylens surfaces
- AI thread naming now uses deterministic intent heuristics for reports, focus flows, and entity questions instead of defaulting to generic prompt fragments

### Changed
- Monthly recap comparisons now use matched elapsed-day windows so longer months do not invent a gain over shorter previous months
- Recap workstream rankings now keep dominant unnamed work visible when attribution is still weak instead of overstating named coverage

### Fixed
- Weak AI thread titles now upgrade after the first grounded answer resolves intent, so chats do not stay stuck on `New chat` or filler-led snippets

## v1.0.26 - 2026-04-19

### Added
- Persistent AI threads and artifact storage inside the AI surface
- A deterministic daily, weekly, and monthly recap card inside the AI surface
- Install-flow, onboarding, and shell polish across the shared desktop app

### Changed
- Cross-platform parity guidance now reflects the unified desktop repo more honestly across macOS, Windows, and Linux

### Fixed
- Shared release notes now keep updater metadata filenames consistent across platform downloads
