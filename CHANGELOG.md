# Changelog

## Unreleased - week of 2026-05-01

### Changed
- **A no-warning Windows install path is in progress.** Daylens now has a Microsoft Store packaging lane so a future Windows build can be Microsoft-signed during Store certification, avoiding SmartScreen warnings on first launch. The Store listing is not live yet — Windows users should keep using the existing signed installer guidance in [INSTALL.md](docs/INSTALL.md) until the Store entry is published. Status is tracked in [docs/ISSUES.md](docs/ISSUES.md).

## v1.0.35 - 2026-04-30

### Added
- **Smarter work history.** Timeline blocks now split sustained context changes, cap very long deterministic blocks, and keep file, page, repo, and window-title evidence ahead of raw app names.
- **Better app context.** Apps now opens on today's activity and focuses each app detail on what you did there, the files and documents touched, pages visited, and tools used alongside it.

### Changed
- **Cleaner daily and weekly views.** Timeline and AI summary copy now avoid overconfident focus-percentage language and emphasize tracked work blocks, artifacts, and activity patterns instead.
- **AI answers sound less like an app list.** Day summaries, weekly reviews, app narratives, generated reports, and chat prompts now explicitly avoid using raw app names as the activity itself.

### Fixed
- **Updates show honest progress.** Downloads no longer sit at a fake 0%, and public Windows releases are blocked unless the installer is signed.
- **Daylens stops tracking itself.** Foreground capture now filters Daylens windows and Daylens project-title sessions before they can pollute the timeline or artifact evidence.
- **Daily notifications open the right recap.** Day Wrapped and Morning Brief click-through now show the requested report date even when the window was hidden or the day has no tracked activity yet.
- **AI answers use the evidence Daylens has.** Files/docs/pages questions now use local files, pages, window titles, and timeline evidence instead of showing a hollow fallback when only app sessions exist.
- **Daily summaries stay grounded.** Timeline summaries avoid malformed JSON, keep wording cautious when evidence is thin, and stop inventing intent from app or browser names alone.
- **Settings hides raw sync errors.** Expired workspace links and server failures now show short recovery guidance instead of stack traces or request internals.
- **Timeline and app icons are calmer.** The right inspector keeps its scrollbar hidden while remaining scrollable, and Microsoft 365, WhatsApp, GitHub, ChatGPT, OneDrive, LinkedIn, and FaceTime labels render consistently across Timeline, Apps, and artifact views.

## v1.0.34 - 2026-04-29

### Added
- **Day Wrapped and Morning Brief.** Daily summary notifications now open a polished Wrapped-style experience, with morning briefs showing yesterday through a rotating warm video opener, identity slide, forward-looking nudge, and AI report CTA when a prepared thread exists.
- **Bundled morning visuals.** Six lightweight morning video loops are bundled into the renderer so the brief can feel different across days without depending on files from the user's Downloads folder.

### Changed
- **Onboarding is calmer and more direct.** The first-run flow now uses a single-headline welcome, dots-only progress, sky-blue primary buttons, plain proof rows, and larger one-column personalization chips.
- **Morning notifications prepare yesterday's report.** The morning notification is now titled "Morning Brief is ready", includes an Open action, and routes to yesterday's recap instead of sending the user to an empty today view.

### Fixed
- **Wrapped report buttons stay clickable.** The final Wrapped actions explicitly stop slide navigation from swallowing report and dismiss clicks.
- **Windows public releases now refuse unsigned installers.** The Windows release workflow now requires Authenticode signing credentials and verifies signatures before publishing, preventing another unsigned public installer from being uploaded by accident.

## v1.0.33 - 2026-04-28

### Fixed
- **Follow-up suggestions no longer show garbage entities.** Router-set topics (e.g. `"The"`, `"Hey Tonny"`) are now validated against a grammar-word stop list before reaching `scopedCandidates`, eliminating suggestions like `"What drove The?"`. A separate, narrower stop list is used for router topics so legitimate short terms like `"AI"` are not incorrectly rejected.
- **`e.g` no longer extracted as a named entity.** The filename-detection regex in `answerEntity` now requires ≥2 characters on both sides of the dot, preventing abbreviations like `e.g`, `i.e`, and `etc` from matching. Added those tokens to `ENTITY_STOP_WORDS` as a secondary guard.
- **Files tab now reliably shows generated artifacts.** The `listArtifacts` refresh in `handleSend` previously used a stale closure for the thread ID on new threads; it now resolves the ID from the freshly-fetched thread list. The artifact `useEffect` dependency was changed from `messages.length` (which does not change on turn completion) to a dedicated `artifactsVersion` counter that increments after every successful turn.
- **Generated files auto-switch view to Files tab.** When a turn produces artifacts the AI view automatically switches to the Files tab so generated files are immediately visible without a manual tab click.
- **Thinking… no longer re-appears after streaming content starts.** A `streamedContentIdsRef` set tracks which message IDs have received at least one non-empty streaming chunk; once a message has streamed content it never reverts to the Thinking… indicator regardless of React batching or snapshot ordering.
- **Thread titles no longer stuck as greeting text.** `deriveTitleFromMessage` now returns `"New chat"` for single-word greeting messages (`"hi"`, `"hey"`, `"ok"`, etc.) instead of echoing the greeting as the thread title. The first substantive follow-up message renames the thread synchronously before `listThreads` is called on the renderer side.
- **Empty AI responses no longer corrupt conversation history.** `sanitizeConversationHistory` now strips user+assistant pairs where the assistant content is empty before sending history to the provider; a dangling empty assistant message previously caused some providers to return a blank response on the next turn.
- **Haiku follow-up prompt rewritten for Perplexity-quality output.** The system prompt now enforces entity-grounding (names pulled only from the answer text), varied question types (time / content / comparison / cause), explicit forbidden-phrase list, concrete good/bad examples, and an explicit `[]` return for greetings or no-data responses.

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
